use super::Store;
use crate::{
    job_definitions::{self, Claim, Reply, Request, Work},
    orchestration::{Actor, Scope},
};
use serde_json::{Value, json};

const NOW: u64 = 1_792_416_000_000;
fn owner() -> Actor {
    Actor {
        issuer: "owner".into(),
        scope: Scope::Owner,
    }
}
fn spec(at: u64) -> Value {
    json!({"title":"Scheduled work","instruction":"Record an explicit result","profile":{"program":"claude","workspace":"shared","harness":true,"allowedNesvoTools":["nesvo_get_current_task","nesvo_report_task_result"]},"schedule":{"kind":"once","at":chrono::DateTime::from_timestamp_millis(at as i64).unwrap().to_rfc3339()}})
}
fn request(store: &mut Store, request: Value, now: u64) -> anyhow::Result<Value> {
    job_definitions::execute(
        &mut store.0,
        owner(),
        serde_json::from_value(request).unwrap(),
        now,
    )
}
fn create(store: &mut Store, key: &str, extra: Value) -> Value {
    let mut spec = spec(NOW + 10_000);
    spec.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    request(store, json!({"action":"create","key":key,"spec":spec}), NOW).unwrap()["job"].clone()
}
fn tick(store: &mut Store, now: u64) -> Vec<Claim> {
    match job_definitions::work(&mut store.0, Work::Tick, now).unwrap() {
        Reply::Claims(claims) => claims,
        _ => panic!("Expected claims"),
    }
}
fn history(store: &mut Store, job: &Value) -> Value {
    request(store, json!({"action":"history","jobId":job["id"]}), NOW).unwrap()["occurrences"]
        .clone()
}
fn code(result: anyhow::Result<Value>, expected: &str) {
    assert_eq!(
        result
            .unwrap_err()
            .downcast_ref::<crate::api_error::Error>()
            .unwrap()
            .code,
        expected
    );
}

#[test]
fn once_admission_is_durable_atomic_and_distinct_from_success_or_idle() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let job = create(&mut store, "once", json!({}));
    assert!(tick(&mut store, NOW + 9999).is_empty());
    let claims = tick(&mut store, NOW + 10_000);
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].job_id, job["id"]);
    assert_eq!(claims[0].spec.instruction, "Record an explicit result");
    assert_eq!(history(&mut store, &job)[0]["state"], "dispatching");
    assert!(tick(&mut store, NOW + 10_001).is_empty());
    job_definitions::work(
        &mut store.0,
        Work::Started {
            occurrence: claims[0].id.clone(),
        },
        NOW + 10_002,
    )
    .unwrap();
    assert_eq!(history(&mut store, &job)[0]["state"], "running");
    assert!(history(&mut store, &job)[0]["finishedAt"].is_null());
    assert!(request(&mut store,json!({"action":"get","jobId":job["id"]}),NOW).unwrap()["job"]["nextDueAt"].is_null());
}
#[test]
fn replay_precedes_live_clock_and_revision_and_changed_intent_conflicts() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let original = json!({"action":"create","key":"immutable","spec":spec(NOW+10_000)});
    let first = request(&mut store, original.clone(), NOW).unwrap();
    assert_eq!(
        request(&mut store, original.clone(), NOW + 99_000).unwrap(),
        first
    );
    let mut changed = original;
    changed["spec"]["instruction"] = "Different intent".into();
    code(request(&mut store, changed, NOW), "idempotency_conflict");
    let now =
        json!({"action":"runNow","key":"manual","jobId":first["job"]["id"],"expectedRevision":1});
    let accepted = request(&mut store, now.clone(), NOW).unwrap();
    let disable = json!({"action":"setEnabled","key":"disabled","jobId":first["job"]["id"],"expectedRevision":1,"enabled":false});
    request(&mut store, disable, NOW).unwrap();
    assert_eq!(request(&mut store, now, NOW + 500_000).unwrap(), accepted);
    assert_eq!(
        history(&mut store, &first["job"]).as_array().unwrap().len(),
        1
    );
}
#[test]
fn sleep_restart_grace_and_skip_never_create_an_unbounded_backlog() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let catchup = create(
        &mut store,
        "catchup",
        json!({"misfire":"catchUp","graceMs":60_000}),
    );
    let skipped = create(&mut store, "skip", json!({"misfire":"skip"}));
    assert_eq!(tick(&mut store, NOW + 20_000).len(), 1);
    assert_eq!(history(&mut store, &skipped)[0]["reason"], "missed_window");
    assert_eq!(history(&mut store, &catchup)[0]["state"], "dispatching");
    job_definitions::recover(&mut store.0, NOW + 30_000).unwrap();
    assert_eq!(history(&mut store, &catchup)[0]["state"], "reconcile");
    assert!(tick(&mut store, NOW + 40_000).is_empty());
    let expired = create(&mut store, "expired", json!({"graceMs":1000}));
    assert!(tick(&mut store, NOW + 200_000).is_empty());
    assert_eq!(history(&mut store, &expired)[0]["state"], "skipped");
}
#[test]
fn definition_edits_do_not_rewrite_queued_occurrence_intent_and_disable_preserves_manual_intent() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let job = create(&mut store, "editable", json!({"overlap":"queue"}));
    let queued = request(
        &mut store,
        json!({"action":"runNow","key":"old-profile","jobId":job["id"],"expectedRevision":1}),
        NOW,
    )
    .unwrap();
    let mut edited = spec(NOW + 50_000);
    edited["instruction"] = "New instruction".into();
    request(&mut store,json!({"action":"update","key":"edit","jobId":job["id"],"expectedRevision":1,"spec":edited}),NOW).unwrap();
    request(&mut store,json!({"action":"setEnabled","key":"pause","jobId":job["id"],"expectedRevision":2,"enabled":false}),NOW).unwrap();
    let claims = tick(&mut store, NOW + 1);
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].id, queued["occurrence"]["id"]);
    assert_eq!(claims[0].spec.instruction, "Record an explicit result");
    assert!(tick(&mut store, NOW + 60_000).is_empty());
    code(
        request(
            &mut store,
            json!({"action":"setEnabled","key":"stale","jobId":job["id"],"expectedRevision":1,"enabled":true}),
            NOW,
        ),
        "revision_conflict",
    );
}
#[test]
fn overlaps_skip_or_queue_one_and_recovery_does_not_dispatch_behind_unknown_effects() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    for (key, policy) in [("skip", "skip"), ("queue", "queue")] {
        let job = create(&mut store, key, json!({"overlap":policy}));
        let first=request(&mut store,json!({"action":"runNow","key":format!("{key}-one"),"jobId":job["id"],"expectedRevision":1}),NOW).unwrap();
        assert_eq!(tick(&mut store, NOW).len(), 1);
        let second=request(&mut store,json!({"action":"runNow","key":format!("{key}-two"),"jobId":job["id"],"expectedRevision":1}),NOW).unwrap();
        assert_eq!(
            second["occurrence"]["state"],
            if policy == "skip" {
                "skipped"
            } else {
                "queued"
            }
        );
        let third=request(&mut store,json!({"action":"runNow","key":format!("{key}-three"),"jobId":job["id"],"expectedRevision":1}),NOW).unwrap();
        assert_eq!(third["occurrence"]["state"], "skipped");
        if policy == "queue" {
            assert_eq!(third["occurrence"]["reason"], "queue_full");
        }
        job_definitions::recover(&mut store.0, NOW + 1).unwrap();
        assert!(tick(&mut store, NOW + 2).is_empty());
        let saved=request(&mut store,json!({"action":"occurrence","jobId":job["id"],"occurrenceId":first["occurrence"]["id"]}),NOW).unwrap();
        assert_eq!(saved["occurrence"]["state"], "reconcile");
    }
}
#[test]
fn owner_only_validation_and_transaction_failure_leave_no_partial_definitions() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    for scope in [Scope::Coordinator("c".into()), Scope::Worker("w".into())] {
        let result = job_definitions::execute(
            &mut store.0,
            Actor {
                issuer: "session:scoped".into(),
                scope,
            },
            Request::List { offset: 0 },
            NOW,
        );
        code(result, "forbidden");
    }
    for extra in [
        json!({"schedule":{"kind":"once","at":"2026-10-20T16:02:00"}}),
        json!({"graceMs":86_400_001}),
        json!({"instruction":""}),
        json!({"profile":{"program":"shell","workspace":"shared"}}),
    ] {
        let mut invalid = spec(NOW + 10_000);
        invalid
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(
            request(
                &mut store,
                json!({"action":"create","key":"invalid","spec":invalid}),
                NOW
            )
            .is_err()
        );
    }
    store.0.execute_batch("CREATE TRIGGER fail_job_event BEFORE INSERT ON domain_events WHEN NEW.kind='job.changed' BEGIN SELECT RAISE(FAIL,'fixture'); END;").unwrap();
    assert!(
        request(
            &mut store,
            json!({"action":"create","key":"rolled-back","spec":spec(NOW+10_000)}),
            NOW
        )
        .is_err()
    );
    let count: i64 = store
        .0
        .query_row("SELECT count(*) FROM harness_jobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
    let count: i64 = store
        .0
        .query_row("SELECT count(*) FROM harness_job_mutations", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}
#[test]
fn native_admission_is_claimed_once_across_sqlite_writers_and_reopen_preserves_original_intent() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-job-domain-{}.sqlite",
        hex::encode(crate::wire::random::<8>())
    ));
    let mut first = Store::open(&path).unwrap();
    let mut second = Store::open(&path).unwrap();
    let job = create(&mut first, "persisted-once", json!({}));
    let claimed = tick(&mut first, NOW + 10_000);
    assert_eq!(claimed.len(), 1);
    assert!(tick(&mut second, NOW + 10_000).is_empty());
    let accepted = history(&mut second, &job);
    assert_eq!(accepted[0]["id"], claimed[0].id);
    drop(first);
    drop(second);
    let mut reopened = Store::open(&path).unwrap();
    assert!(tick(&mut reopened, NOW + 11_000).is_empty());
    let saved = request(
        &mut reopened,
        json!({"action":"occurrence","jobId":job["id"],"occurrenceId":claimed[0].id}),
        NOW,
    )
    .unwrap();
    assert_eq!(saved["occurrence"]["state"], "reconcile");
    assert_eq!(
        saved["occurrence"]["spec"]["instruction"],
        "Record an explicit result"
    );
    drop(reopened);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn quiet_ticks_make_no_writes_or_events_and_offsets_resolve_to_one_absolute_due_instant() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let at = chrono::DateTime::from_timestamp_millis((NOW + 10_000) as i64)
        .unwrap()
        .with_timezone(&chrono::FixedOffset::east_opt(7200).unwrap())
        .to_rfc3339();
    let job = create(
        &mut store,
        "offset-instant",
        json!({"schedule":{"kind":"once","at":at}}),
    );
    assert_eq!(job["nextDueAt"], NOW + 10_000);
    let before: i64 = store
        .0
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap();
    for n in 0..100 {
        assert!(tick(&mut store, NOW + n).is_empty());
    }
    let after: i64 = store
        .0
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        before, after,
        "No heartbeat metadata, journal or timer writes when nothing changed"
    );
    assert_eq!(tick(&mut store, NOW + 10_000).len(), 1);
}
#[test]
fn running_blocker_changes_and_resolution_publish_once_without_heartbeat_events() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let job = create(&mut store, "reason-projection", json!({}));
    request(
        &mut store,
        json!({"action":"runNow","key":"reason-run-now","jobId":job["id"],"expectedRevision":1}),
        NOW,
    )
    .unwrap();
    let claim = tick(&mut store, NOW).pop().unwrap();
    let workflow = |store: &mut Store, value: Value| {
        crate::orchestration::execute_at(
            &mut store.0,
            owner(),
            serde_json::from_value(value).unwrap(),
            NOW,
        )
        .unwrap()
    };
    let created = workflow(
        &mut store,
        json!({"action":"create","key":"reason-run","spec":{"title":"Blocker changes","goal":"Metadata projection only"}}),
    );
    let run = created["run"]["id"].as_str().unwrap();
    let plan = workflow(
        &mut store,
        json!({"action":"setPlan","key":"reason-plan","runId":run,"expectedRevision":1,"tasks":[{"key":"job","title":"One task","instruction":"No native dispatch in this unit test"}]}),
    );
    let active = workflow(
        &mut store,
        json!({"action":"activate","key":"reason-active","runId":run,"expectedRevision":plan["run"]["revision"]}),
    );
    let managed=crate::workflow_executor::execute(&mut store.0,crate::workflow_executor::Work::Manage{actor:owner(),request:serde_json::from_value(json!({"action":"start","key":"reason-executor","runId":run,"expectedRevision":active["run"]["revision"],"spec":{"tasks":[{"taskId":plan["tasks"][0]["id"],"profile":claim.spec.profile}]}})).unwrap()},NOW).unwrap();
    let crate::workflow_executor::Reply::Managed {
        pump: Some(guard), ..
    } = managed
    else {
        panic!("Expected metadata executor guard");
    };
    job_definitions::work(
        &mut store.0,
        Work::BindRun {
            occurrence: claim.id.clone(),
            run: run.into(),
        },
        NOW,
    )
    .unwrap();
    job_definitions::work(
        &mut store.0,
        Work::Started {
            occurrence: claim.id,
        },
        NOW,
    )
    .unwrap();
    let count = |store: &Store| {
        store
            .0
            .query_row(
                "SELECT count(*) FROM domain_events WHERE kind='job.changed'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
    };
    let before = count(&store);
    for (index, reason) in [Some("control_busy".to_owned()), None]
        .into_iter()
        .enumerate()
    {
        crate::workflow_executor::execute(
            &mut store.0,
            crate::workflow_executor::Work::Note {
                guard: guard.clone(),
                issuer: "owner".into(),
                phase: "waiting",
                reason: reason.clone(),
                task_id: None,
                disable: false,
            },
            NOW + 1,
        )
        .unwrap();
        assert!(tick(&mut store, NOW + 2).is_empty());
        assert_eq!(
            history(&mut store, &job)[0]["reason"],
            serde_json::to_value(reason).unwrap()
        );
        assert_eq!(count(&store), before + index as i64 + 1);
        assert!(tick(&mut store, NOW + 3).is_empty());
        assert_eq!(count(&store), before + index as i64 + 1);
    }
}
