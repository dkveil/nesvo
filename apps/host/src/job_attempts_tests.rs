use super::{Store, job_retries_tests as retries};
use crate::{
    job_attempts, job_cancellations,
    orchestration::{Actor, Scope},
};
use rusqlite::params;
use serde_json::{Value, json};

const NOW: i64 = 1_792_416_000_000;

fn store() -> Store {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    job_attempts::initialize(&store.0).unwrap();
    store
}
fn occurrence(
    store: &Store,
    job: &str,
    id: &str,
    state: &str,
    claimed: Option<i64>,
    finished: Option<i64>,
    run: Option<&str>,
) {
    store.0.execute("INSERT OR IGNORE INTO harness_jobs(id,spec,revision,enabled,next_due,created_at) VALUES(?1,'{}',1,0,NULL,?2)",params![job,NOW]).unwrap();
    store.0.execute("INSERT INTO harness_job_occurrences(id,job_id,job_revision,spec,trigger_key,trigger_kind,due_at,created_at,state,run_id,started_at,finished_at) VALUES(?1,?2,1,'{}',?1,'manual',?3,?3,?4,?5,?6,?7)",params![id,job,NOW,state,run,claimed,finished]).unwrap();
}
fn run(store: &Store, id: &str) {
    store.0.execute("INSERT INTO workflow_runs(id,title,goal,coordinator_id,revision,state,created_at) VALUES(?1,'Journal fixture','Metadata only',NULL,1,'active',?2)",params![id,NOW]).unwrap();
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
fn precheck(store: &Store, occurrence: &str, state: &str, result: Option<&Value>) {
    store.0.execute("INSERT INTO harness_job_prechecks(occurrence_id,approval_id,approval_digest,state,reason,started_at,finished_at,result,observed_at) VALUES(?1,'historical-approval','historical-digest',?2,'retained evidence',?3,?4,?5,?3)",params![occurrence,state,NOW+1,(state!="running"&&state!="unknown").then_some(NOW+2),result.map(Value::to_string)]).unwrap();
}

#[test]
fn backfill_copies_claimed_history_without_inventing_execution_or_rewriting_acceptance() {
    let mut store = store();
    run(&store, "historical-run");
    occurrence(
        &store,
        "legacy-job",
        "never-claimed",
        "queued",
        None,
        None,
        None,
    );
    occurrence(
        &store,
        "legacy-job",
        "unclaimed-skip",
        "skipped",
        None,
        Some(NOW + 2),
        None,
    );
    occurrence(
        &store,
        "legacy-job",
        "unclaimed-cancel",
        "canceled",
        None,
        Some(NOW + 2),
        None,
    );
    occurrence(
        &store,
        "legacy-job",
        "pending",
        "dispatching",
        Some(NOW + 1),
        None,
        None,
    );
    occurrence(
        &store,
        "legacy-job",
        "checking",
        "prechecking",
        Some(NOW + 1),
        None,
        None,
    );
    occurrence(
        &store,
        "legacy-job",
        "passed",
        "running",
        Some(NOW + 1),
        None,
        Some("historical-run"),
    );
    occurrence(
        &store,
        "legacy-job",
        "unknown",
        "reconcile",
        Some(NOW + 1),
        None,
        None,
    );
    occurrence(
        &store,
        "legacy-job",
        "failed",
        "failed",
        Some(NOW + 1),
        Some(NOW + 3),
        None,
    );
    let result = json!({"state":"passed","reason":"pass_exit","exitCode":0,"durationMs":1,"cleanupConfirmed":true,"commandStarted":true,"stdout":"actual retained output","stderr":"","stdoutTruncated":false,"stderrTruncated":false});
    precheck(&store, "checking", "running", None);
    precheck(&store, "passed", "passed", Some(&result));
    precheck(&store, "unknown", "unknown", None);
    let accepted =
        "{\n  \"occurrence\": {\"id\":\"passed\",\"state\":\"queued\",\"runId\":null}\n}";
    store.0.execute("INSERT INTO harness_job_mutations(issuer,key,digest,view) VALUES('owner','legacy-key','legacy-fingerprint',?1)",[accepted]).unwrap();
    {
        let tx = store.0.transaction().unwrap();
        job_attempts::backfill(&tx).unwrap();
        tx.commit().unwrap();
    }
    let rows: i64 = store
        .0
        .query_row("SELECT count(*) FROM harness_job_attempts", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(rows, 5);
    for id in ["never-claimed", "unclaimed-skip", "unclaimed-cancel"] {
        assert!(
            job_attempts::view(&store.0, "legacy-job", id, None, 0).unwrap()["jobAttempts"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    for (id, state) in [
        ("pending", "dispatching"),
        ("checking", "prechecking"),
        ("passed", "running"),
        ("unknown", "reconcile"),
        ("failed", "failed"),
    ] {
        let summary = job_attempts::view(&store.0, "legacy-job", id, None, 0).unwrap();
        let row = &summary["jobAttempts"][0];
        assert_eq!(row["ordinal"], 1);
        assert_eq!(row["createdAt"], NOW);
        assert_eq!(row["claimedAt"], NOW + 1);
        assert_eq!(row["state"], state);
        assert_eq!(
            row["finishedAt"],
            if id == "failed" {
                json!(NOW + 3)
            } else {
                Value::Null
            }
        );
        assert!(row["attemptId"].is_null());
        assert!(
            row["sessionId"].is_null(),
            "A Run pointer does not manufacture a native process"
        );
    }
    let summary = job_attempts::view(&store.0, "legacy-job", "passed", None, 0).unwrap();
    let id = summary["jobAttempts"][0]["id"].as_str().unwrap();
    let detail = job_attempts::view(&store.0, "legacy-job", "passed", Some(id), 0).unwrap();
    assert_eq!(detail["jobAttempt"]["precheck"]["result"], result);
    assert_eq!(detail["jobAttempt"]["runId"], "historical-run");
    assert_eq!(detail["jobAttempt"]["runState"], "active");
    assert!(detail["jobAttempt"]["result"].is_null());
    let before: i64 = store
        .0
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap();
    {
        let tx = store.0.transaction().unwrap();
        job_attempts::backfill(&tx).unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(
        store
            .0
            .query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        before
    );
    let retained:(String,String)=store.0.query_row("SELECT digest,view FROM harness_job_mutations WHERE issuer='owner' AND key='legacy-key'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(retained, ("legacy-fingerprint".into(), accepted.into()));
}

#[test]
fn begin_bind_and_sync_are_idempotent_and_preserve_first_identity_and_timestamps() {
    let mut store = store();
    occurrence(&store, "job", "queued", "queued", None, None, None);
    occurrence(
        &store,
        "job",
        "claimed",
        "dispatching",
        Some(NOW + 5),
        None,
        None,
    );
    occurrence(
        &store,
        "job",
        "other",
        "dispatching",
        Some(NOW + 5),
        None,
        None,
    );
    run(&store, "run-one");
    run(&store, "run-two");
    let tx = store.0.transaction().unwrap();
    code(
        job_attempts::begin(&tx, "queued", NOW as u64),
        "job_attempt_conflict",
    );
    let id = job_attempts::begin(&tx, "claimed", (NOW + 5) as u64).unwrap();
    let before: i64 = tx
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        job_attempts::begin(&tx, "claimed", (NOW + 5000) as u64).unwrap(),
        id
    );
    assert_eq!(
        tx.query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        before
    );
    job_attempts::bind(&tx, "claimed", "run-one").unwrap();
    job_attempts::bind(&tx, "claimed", "run-one").unwrap();
    code(
        job_attempts::bind(&tx, "claimed", "run-two"),
        "job_attempt_conflict",
    );
    job_attempts::begin(&tx, "other", (NOW + 5) as u64).unwrap();
    code(
        job_attempts::bind(&tx, "other", "run-one"),
        "job_attempt_conflict",
    );
    job_attempts::sync(&tx, "claimed", "prechecking", None, None).unwrap();
    job_attempts::sync(
        &tx,
        "claimed",
        "reconcile",
        Some("unknown command outcome"),
        None,
    )
    .unwrap();
    job_attempts::sync(
        &tx,
        "claimed",
        "failed",
        Some("known refusal"),
        Some((NOW + 10) as u64),
    )
    .unwrap();
    let before: i64 = tx
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap();
    job_attempts::sync(
        &tx,
        "claimed",
        "failed",
        Some("known refusal"),
        Some((NOW + 100) as u64),
    )
    .unwrap();
    assert_eq!(
        tx.query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        before,
        "A quiet observation does not rewrite the first finish time"
    );
    code(
        job_attempts::sync(&tx, "claimed", "invented", None, None),
        "invalid_argument",
    );
    job_attempts::sync(
        &tx,
        "queued",
        "canceled",
        Some("never claimed"),
        Some((NOW + 10) as u64),
    )
    .unwrap();
    tx.commit().unwrap();
    let detail = job_attempts::view(&store.0, "job", "claimed", Some(&id), 0).unwrap();
    assert_eq!(detail["jobAttempt"]["runId"], "run-one");
    assert_eq!(detail["jobAttempt"]["createdAt"], NOW);
    assert_eq!(detail["jobAttempt"]["claimedAt"], NOW + 5);
    assert_eq!(detail["jobAttempt"]["finishedAt"], NOW + 10);
    assert_eq!(detail["jobAttempt"]["reason"], "known refusal");
    assert!(
        job_attempts::view(&store.0, "job", "queued", None, 0).unwrap()["jobAttempts"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn history_is_bounded_and_tuple_scoped_and_detail_keeps_actual_evidence() {
    let mut store = store();
    run(&store, "native-run");
    occurrence(
        &store,
        "job",
        "history",
        "running",
        Some(NOW + 1),
        None,
        Some("native-run"),
    );
    occurrence(
        &store,
        "foreign-job",
        "foreign",
        "dispatching",
        Some(NOW + 1),
        None,
        None,
    );
    let result = json!({"outcome":"succeeded","summary":"Original report","files":["src/one.rs"],"artifacts":["report.txt"],"checks":[{"name":"check","outcome":"passed","details":"exact retained check"}],"limitations":[]});
    let validation = json!({"passed":false,"summary":"Actual rejection","checks":[{"name":"review","outcome":"failed","details":"retained owner review"}],"source":"ownerAttestation","validatorSessionId":null});
    store.0.execute("INSERT INTO workflow_tasks(id,run_id,task_key,spec) VALUES('task','native-run','job','{}')",[]).unwrap();
    store.0.execute("INSERT INTO workflow_attempts(id,task_id,ordinal,session_id,state,result,validation) VALUES('native-attempt','task',1,'native-session','failed',?1,?2)",params![result.to_string(),validation.to_string()]).unwrap();
    store.0.execute("INSERT INTO operation_receipts(id,issuer,key,digest,operation,phase,session_id,result) VALUES('launch','owner','launch-key','digest','create','created','native-session','{}')",[]).unwrap();
    store.0.execute("INSERT INTO workflow_launches(attempt_id,operation_id,operation_key,workspace,created_at) VALUES('native-attempt','launch','launch-key','shared',?1)",[NOW+2]).unwrap();
    let check = json!({"state":"passed","reason":"pass_exit","exitCode":0,"durationMs":1,"cleanupConfirmed":true,"commandStarted":true,"stdout":"retained command output","stderr":"retained diagnostic","stdoutTruncated":false,"stderrTruncated":false});
    precheck(&store, "history", "passed", Some(&check));
    let tx = store.0.transaction().unwrap();
    let first = job_attempts::begin(&tx, "history", NOW as u64).unwrap();
    let foreign = job_attempts::begin(&tx, "foreign", NOW as u64).unwrap();
    for ordinal in 2..=10 {
        tx.execute("INSERT INTO harness_job_attempts(id,occurrence_id,ordinal,created_at,claimed_at,state) VALUES(?1,'history',?2,?3,?3,'failed')",params![format!("synthetic-{ordinal}"),ordinal,NOW+ordinal]).unwrap();
    }
    tx.commit().unwrap();
    let page = job_attempts::view(&store.0, "job", "history", None, 0).unwrap();
    let rows = page["jobAttempts"].as_array().unwrap();
    assert_eq!(rows.len(), 8);
    assert_eq!(rows[0]["ordinal"], 10);
    assert_eq!(rows[7]["ordinal"], 3);
    assert_eq!(page["nextOffset"], 8);
    assert!(
        rows.iter()
            .all(|row| row.get("result").is_none() && row.get("validation").is_none())
    );
    let last = job_attempts::view(&store.0, "job", "history", None, 8).unwrap();
    assert_eq!(last["jobAttempts"].as_array().unwrap().len(), 2);
    assert!(last["nextOffset"].is_null());
    let summary = &last["jobAttempts"][1];
    assert_eq!(summary["id"], first);
    assert_eq!(summary["attemptId"], "native-attempt");
    assert_eq!(summary["sessionId"], "native-session");
    assert_eq!(summary["launchReceiptId"], "launch");
    assert!(summary["precheck"]["result"].get("stdout").is_none());
    assert!(summary["precheck"]["result"].get("stderr").is_none());
    let detail = job_attempts::view(&store.0, "job", "history", Some(&first), 0).unwrap();
    assert_eq!(detail["jobAttempt"]["result"], result);
    assert_eq!(detail["jobAttempt"]["validation"], validation);
    assert_eq!(detail["jobAttempt"]["precheck"]["result"], check);
    code(
        job_attempts::view(&store.0, "foreign-job", "history", None, 0),
        "occurrence_not_found",
    );
    code(
        job_attempts::view(&store.0, "job", "history", Some(&foreign), 0),
        "job_attempt_not_found",
    );
    code(
        job_attempts::view(&store.0, "job", "history", None, 4097),
        "invalid_argument",
    );
    code(
        job_attempts::view(&store.0, "job", "history", Some(&first), 1),
        "invalid_argument",
    );
    assert!(
        job_attempts::view(&store.0, "job", "history", None, 4096).unwrap()["jobAttempts"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn canceled_occurrence_fences_historical_runs_when_current_pointer_advances() {
    let mut store = store();
    run(&store, "old-run");
    run(&store, "future-run");
    occurrence(
        &store,
        "job",
        "occurrence",
        "running",
        Some(NOW + 1),
        None,
        Some("old-run"),
    );
    let tx = store.0.transaction().unwrap();
    job_attempts::begin(&tx, "occurrence", NOW as u64).unwrap();
    job_cancellations::accept(
        &tx,
        &Actor {
            issuer: "owner".into(),
            scope: Scope::Owner,
        },
        "job",
        "occurrence",
        (NOW + 2) as u64,
    )
    .unwrap();
    tx.execute("INSERT INTO harness_job_attempts(id,occurrence_id,ordinal,run_id,created_at,claimed_at,state) VALUES('future-generation','occurrence',2,'future-run',?1,?1,'dispatching')",[NOW+3]).unwrap();
    tx.execute(
        "UPDATE harness_job_occurrences SET run_id='future-run' WHERE id='occurrence'",
        [],
    )
    .unwrap();
    code(job_cancellations::guard_run(&tx, "old-run"), "job_canceled");
    code(
        job_cancellations::guard_run(&tx, "future-run"),
        "job_canceled",
    );
    job_cancellations::guard_run(&tx, "unrelated-run").unwrap();
    tx.commit().unwrap();
}

#[test]
fn legacy_disk_reopen_backfills_once_and_preserves_original_evidence_and_keys() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-job-generation-migration-{}.sqlite",
        hex::encode(crate::wire::random::<8>())
    ));
    let accepted =
        "{\n  \"occurrence\": {\"id\":\"reported\",\"state\":\"queued\",\"runId\":null}\n}";
    let report = json!({"outcome":"succeeded","summary":"Retained legacy worker report","files":["src/legacy.rs"],"artifacts":[],"checks":[{"name":"legacy check","outcome":"passed","details":"Historical explicit report, not a newly executed check"}],"limitations":["Synthetic historical fixture; no native process executed"]});
    let mutation = |store: &Store| -> (String, String) {
        store.0.query_row("SELECT digest,view FROM harness_job_mutations WHERE issuer='owner' AND key='old-accepted-key'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap()
    };
    {
        let legacy = Store::legacy_initialize(&path).unwrap();
        run(&legacy, "legacy-run");
        for (id, state, claimed, finished, run) in [
            (
                "reported",
                "needsValidation",
                Some(NOW + 1),
                None,
                Some("legacy-run"),
            ),
            ("failed", "failed", Some(NOW + 2), Some(NOW + 9), None),
            ("checking", "prechecking", Some(NOW + 1), None, None),
            ("queued", "queued", None, None, None),
            ("unclaimed-cancel", "canceled", None, Some(NOW + 3), None),
        ] {
            occurrence(&legacy, "disk-job", id, state, claimed, finished, run);
        }
        let spec=json!({"title":"Legacy disk job","instruction":"report-task","profile":{"program":"claude","workspace":"shared","harness":true},"schedule":{"kind":"once","at":chrono::DateTime::from_timestamp_millis(NOW+60_000).unwrap().to_rfc3339()},"misfire":"catchUp","graceMs":60000,"overlap":"skip","maxElapsedMs":300000}).to_string();
        legacy
            .0
            .execute(
                "UPDATE harness_jobs SET spec=?1 WHERE id='disk-job'",
                [&spec],
            )
            .unwrap();
        legacy
            .0
            .execute(
                "UPDATE harness_job_occurrences SET spec=?1 WHERE job_id='disk-job'",
                [&spec],
            )
            .unwrap();
        legacy.0.execute("INSERT INTO workflow_tasks(id,run_id,task_key,spec) VALUES('disk-task','legacy-run','job',?1)",[json!({"key":"job","title":"Legacy task","instruction":"report-task","dependencies":[]}).to_string()]).unwrap();
        legacy.0.execute("INSERT INTO workflow_attempts(id,task_id,ordinal,session_id,state,result) VALUES('disk-native-attempt','disk-task',1,'disk-native-session','reported',?1)",[report.to_string()]).unwrap();
        legacy.0.execute("INSERT INTO operation_receipts(id,issuer,key,digest,operation,phase,session_id,result) VALUES('disk-launch','owner','disk-launch-key','disk-digest','create','created','disk-native-session','{}')",[]).unwrap();
        legacy.0.execute("INSERT INTO workflow_launches(attempt_id,operation_id,operation_key,workspace,created_at) VALUES('disk-native-attempt','disk-launch','disk-launch-key','shared',?1)",[NOW+2]).unwrap();
        precheck(&legacy, "checking", "running", None);
        legacy.0.execute("INSERT INTO harness_job_mutations(issuer,key,digest,view) VALUES('owner','old-accepted-key','unchanged-legacy-fingerprint',?1)",[accepted]).unwrap();
        legacy
            .0
            .execute_batch("DROP TABLE harness_job_attempts;")
            .unwrap();
        assert_eq!(legacy.0.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='harness_job_attempts'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
    let snapshots = {
        let migrated = Store::open(&path).unwrap();
        assert_eq!(
            migrated
                .0
                .query_row("SELECT count(*) FROM harness_job_attempts", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
        let mut snapshots = Vec::new();
        for (id, state, claimed, finished) in [
            ("reported", "reconcile", NOW + 1, None),
            ("failed", "failed", NOW + 2, Some(NOW + 9)),
            ("checking", "reconcile", NOW + 1, None),
        ] {
            let listed = job_attempts::view(&migrated.0, "disk-job", id, None, 0).unwrap();
            let generation = listed["jobAttempts"][0]["id"].as_str().unwrap();
            let detail =
                job_attempts::view(&migrated.0, "disk-job", id, Some(generation), 0).unwrap();
            let row = &detail["jobAttempt"];
            assert_eq!(row["ordinal"], 1);
            assert_eq!(row["createdAt"], NOW);
            assert_eq!(row["claimedAt"], claimed);
            assert_eq!(row["finishedAt"], json!(finished));
            assert_eq!(row["state"], state);
            if id == "reported" {
                assert_eq!(row["runId"], "legacy-run");
                assert_eq!(row["attemptId"], "disk-native-attempt");
                assert_eq!(row["sessionId"], "disk-native-session");
                assert_eq!(row["launchReceiptId"], "disk-launch");
                assert_eq!(row["result"], report);
                assert!(row["validation"].is_null());
            }
            if id == "checking" {
                assert_eq!(row["precheck"]["state"], "unknown");
                assert!(row["precheck"]["finishedAt"].is_null());
                assert!(row["runId"].is_null());
                assert!(row["sessionId"].is_null());
            }
            snapshots.push((id, detail));
        }
        for id in ["queued", "unclaimed-cancel"] {
            assert!(
                job_attempts::view(&migrated.0, "disk-job", id, None, 0).unwrap()["jobAttempts"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
        }
        assert_eq!(
            mutation(&migrated),
            ("unchanged-legacy-fingerprint".into(), accepted.into())
        );
        snapshots
    };
    {
        let reopened = Store::open(&path).unwrap();
        assert_eq!(
            reopened
                .0
                .query_row("SELECT count(*) FROM harness_job_attempts", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
        for (occurrence, original) in snapshots {
            let id = original["jobAttempt"]["id"].as_str().unwrap();
            assert_eq!(
                job_attempts::view(&reopened.0, "disk-job", occurrence, Some(id), 0).unwrap(),
                original,
                "A second real disk reopen retains generation IDs, bindings, timestamps and observations"
            );
        }
        assert_eq!(
            mutation(&reopened),
            ("unchanged-legacy-fingerprint".into(), accepted.into())
        );
    }
    std::fs::remove_file(path).unwrap();
}

fn generation_record(store: &Store, fixture: &retries::Fixture) -> Value {
    job_attempts::view(
        &store.0,
        &fixture.job,
        &fixture.occurrence,
        Some(&fixture.source),
        0,
    )
    .unwrap()["jobAttempt"]
        .clone()
}

#[test]
fn generation_sync_classifies_only_uncertain_launch_reasons_and_only_once() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let fixture = retries::seed(&store, "sync-class", Some(retries::retry(3)), 1);
    retries::without_native(&store, &fixture);
    retries::retire_producer(&store, &fixture);
    retries::fail(&mut store, &fixture, "precheck_unconfirmed", NOW as u64 + 5);
    let unclassified = generation_record(&store, &fixture);
    assert_eq!(unclassified["state"], "reconcile");
    assert_eq!(unclassified["reason"], "precheck_unconfirmed");
    assert!(unclassified["retryClassification"].is_null());
    retries::fail(&mut store, &fixture, "launch_unconfirmed", NOW as u64 + 6);
    let classified = generation_record(&store, &fixture);
    assert_eq!(classified["state"], "reconcile");
    assert_eq!(classified["reason"], "launch_unconfirmed");
    assert_eq!(
        classified["retryClassification"]["class"],
        "uncertainEffect"
    );
    assert_eq!(classified["retryClassification"]["decision"], "probing");
    assert_eq!(
        classified["retryClassification"]["failure"],
        "launch_unconfirmed"
    );
    assert!(classified["retry"].is_null() && classified["retryAdmission"].is_null());
    let parked: (String, String) = store
        .0
        .query_row(
            "SELECT state,reason FROM harness_job_occurrences WHERE id=?1",
            [&fixture.occurrence],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        parked,
        ("retryWaiting".into(), "retry_probe_pending".into())
    );
    retries::fail(&mut store, &fixture, "dispatch_interrupted", NOW as u64 + 7);
    assert_eq!(
        generation_record(&store, &fixture)["retryClassification"]["failure"],
        "launch_unconfirmed"
    );
    let rows: i64 = store
        .0
        .query_row("SELECT count(*) FROM harness_job_retries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1);
}

#[test]
fn run_fence_ignores_probing_and_adopted_classes_but_holds_every_decided_retry() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let probing = retries::seed(&store, "fence-probing", Some(retries::retry(3)), 1);
    retries::without_native(&store, &probing);
    retries::retire_producer(&store, &probing);
    retries::fail(&mut store, &probing, "dispatch_unconfirmed", NOW as u64 + 5);
    job_attempts::guard_run(&store.0, &probing.run).unwrap();

    let adopted = retries::seed(&store, "fence-adopted", Some(retries::retry(3)), 1);
    retries::native_state(&store, &adopted, "launching", "dispatching", json!({}));
    retries::retire_producer(&store, &adopted);
    retries::fail(&mut store, &adopted, "dispatch_unconfirmed", NOW as u64 + 5);
    assert!(retries::claim(&mut store, &adopted, NOW as u64 + 6).is_none());
    assert_eq!(
        retries::classification(&store, &adopted)["decision"],
        "adopted"
    );
    job_attempts::guard_run(&store.0, &adopted.run).unwrap();

    let decided = retries::seed(&store, "fence-decided", Some(retries::retry(3)), 1);
    retries::without_native(&store, &decided);
    retries::retire_producer(&store, &decided);
    retries::fail(&mut store, &decided, "host_restarted", NOW as u64 + 5);
    assert!(retries::claim(&mut store, &decided, NOW as u64 + 6).is_none());
    code(
        job_attempts::guard_run(&store.0, &decided.run),
        "job_generation_retired",
    );

    let exhausted = retries::seed(&store, "fence-exhausted", Some(retries::retry(1)), 1);
    retries::without_native(&store, &exhausted);
    retries::retire_producer(&store, &exhausted);
    retries::fail(
        &mut store,
        &exhausted,
        "dispatch_interrupted",
        NOW as u64 + 5,
    );
    assert!(retries::claim(&mut store, &exhausted, NOW as u64 + 6).is_none());
    code(
        job_attempts::guard_run(&store.0, &exhausted.run),
        "job_generation_retired",
    );
}

#[test]
fn generation_keys_follow_the_ordinal_used_by_dispatch_and_probes() {
    assert_eq!(
        job_attempts::key_prefix("job", "occurrence", 1),
        "job:job:occurrence"
    );
    assert_eq!(
        job_attempts::key_prefix("job", "occurrence", 2),
        "job:job:occurrence:attempt:2"
    );
}
