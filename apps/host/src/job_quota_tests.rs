use super::Store;
use crate::{
    job_definitions::{self, Claim, Reply, Work},
    job_quota::{self, Binding, Observation},
    orchestration::{Actor, Scope},
};
use rusqlite::params;
use serde_json::{Value, json};

const NOW: u64 = 1_792_416_000_000;
const ELAPSED: u64 = 1000;

fn store() -> Store {
    Store::open(std::path::Path::new(":memory:")).unwrap()
}
fn owner() -> Actor {
    Actor {
        issuer: "owner".into(),
        scope: Scope::Owner,
    }
}
fn binding() -> Binding {
    Binding {
        context_id: "a".repeat(64),
        account_fingerprint: "b".repeat(64),
    }
}
fn policy(binding: &Binding) -> Value {
    json!({"mode":"wait","contextId":binding.context_id,"accountFingerprint":binding.account_fingerprint})
}
fn spec(quota: Option<&Binding>) -> Value {
    let mut value = json!({"title":"Quota admission","instruction":"Metadata only; no provider is executed",
        "profile":{"program":"codex","workspace":"shared","harness":true},
        "schedule":{"kind":"once","at":"2026-12-01T00:00:00Z"},"overlap":"queue"});
    if let Some(binding) = quota {
        value["quotaPolicy"] = policy(binding);
    }
    value
}
fn request(store: &mut Store, request: Value) -> anyhow::Result<Value> {
    job_definitions::execute_at(
        &mut store.0,
        owner(),
        serde_json::from_value(request)?,
        NOW,
        ELAPSED,
    )
}
fn queued(store: &mut Store, key: &str, value: Value) -> (String, String) {
    let created = request(
        store,
        json!({"action":"create","key":format!("{key}:definition"),"spec":value}),
    )
    .unwrap();
    let job = created["job"]["id"].as_str().unwrap().to_owned();
    let accepted = request(
        store,
        json!({"action":"runNow","key":format!("{key}:now"),"jobId":job,"expectedRevision":1}),
    )
    .unwrap();
    (
        job,
        accepted["occurrence"]["id"].as_str().unwrap().to_owned(),
    )
}
fn observation(revision: u64, binding: Option<Binding>, eligible: bool) -> Observation {
    Observation {
        source_id: "codex-workspace".into(),
        revision,
        binding,
        expires_elapsed_ms: ELAPSED + 10_000,
        eligible,
        reason: if eligible {
            "observed"
        } else {
            "backend_denied"
        }
        .into(),
    }
}
fn publish(store: &mut Store, observation: Observation) {
    assert!(matches!(
        job_definitions::work_at(
            &mut store.0,
            Work::QuotaObserved { observation },
            NOW,
            ELAPSED
        )
        .unwrap(),
        Reply::Done
    ));
}
fn poll(store: &mut Store, slots: u8, now: u64, elapsed: u64) -> Vec<Claim> {
    match job_definitions::work_at(&mut store.0, Work::Poll { slots }, now, elapsed).unwrap() {
        Reply::Claims(claims) => claims,
        _ => panic!("Expected quota-filtered claims"),
    }
}
fn quota(store: &Store, id: &str, elapsed: u64) -> Value {
    job_quota::view(&store.0, id, elapsed).unwrap()
}
fn count(store: &Store, table: &str) -> i64 {
    store
        .0
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
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
fn authorize(job: &str, occurrence: &str, old: &Binding, new: &Binding, key: &str) -> Value {
    json!({"action":"authorizeQuota","key":key,"jobId":job,"occurrenceId":occurrence,
        "expectedContextId":old.context_id,"expectedAccountFingerprint":old.account_fingerprint,
        "contextId":new.context_id,"accountFingerprint":new.account_fingerprint})
}

#[test]
fn more_held_rows_than_slots_cannot_starve_unrelated_eligible_work() {
    let mut store = store();
    let mut held = Vec::new();
    for index in 0..6 {
        held.push(queued(&mut store, &format!("held-{index}"), spec(Some(&binding()))).1);
    }
    let (_, ready) = queued(&mut store, "ungated", spec(None));
    let claims = poll(&mut store, 1, NOW, ELAPSED);
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].id, ready);
    for id in held {
        assert_eq!(quota(&store, &id, ELAPSED)["state"], "waiting");
        let untouched:(String,Option<i64>,Option<String>,Option<String>)=store.0.query_row(
            "SELECT state,started_at,current_job_attempt_id,run_id FROM harness_job_occurrences WHERE id=?1",
            [&id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).unwrap();
        assert_eq!(untouched, ("queued".into(), None, None, None));
    }
    assert_eq!(count(&store, "harness_job_attempts"), 1);
    assert_eq!(count(&store, "harness_job_prechecks"), 0);
    assert_eq!(count(&store, "workflow_runs"), 0);
}

#[test]
fn duplicate_or_older_publications_release_exactly_one_original_generation() {
    let mut store = store();
    let (_, id) = queued(&mut store, "once", spec(Some(&binding())));
    assert!(poll(&mut store, 4, NOW, ELAPSED).is_empty());
    let observed = observation(2, Some(binding()), true);
    publish(&mut store, observed.clone());
    let before = count(&store, "domain_events");
    publish(&mut store, observed);
    publish(&mut store, observation(1, None, false));
    assert_eq!(
        count(&store, "domain_events"),
        before,
        "Duplicate/older reads are quiet"
    );
    let claims = poll(&mut store, 4, NOW, ELAPSED);
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].id, id);
    assert!(poll(&mut store, 4, NOW, ELAPSED).is_empty());
    assert_eq!(count(&store, "harness_job_attempts"), 1);
}

#[test]
fn one_publication_cannot_claim_overlapping_siblings_in_the_same_poll() {
    let mut store = store();
    let (_, first) = queued(&mut store, "siblings", spec(Some(&binding())));
    let second = "f".repeat(32);
    store.0.execute("INSERT INTO harness_job_occurrences(id,job_id,job_revision,spec,trigger_key,trigger_kind,due_at,created_at,state) SELECT ?2,job_id,job_revision,spec,'manual:sibling','manual',due_at,created_at,'queued' FROM harness_job_occurrences WHERE id=?1",params![first,second]).unwrap();
    publish(&mut store, observation(1, Some(binding()), true));
    let claims = poll(&mut store, 4, NOW, ELAPSED);
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].id, first);
    assert!(poll(&mut store, 4, NOW, ELAPSED).is_empty());
    let retained:(String,Option<i64>,Option<String>)=store.0.query_row("SELECT state,started_at,current_job_attempt_id FROM harness_job_occurrences WHERE id=?1",[second],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
    assert_eq!(retained, ("queued".into(), None, None));
    assert_eq!(count(&store, "harness_job_attempts"), 1);
}

#[test]
fn newer_failure_or_changed_binding_removes_all_old_source_authority() {
    let mut store = store();
    let (_, id) = queued(&mut store, "source-change", spec(Some(&binding())));
    publish(&mut store, observation(1, Some(binding()), true));
    assert_eq!(quota(&store, &id, ELAPSED)["state"], "eligible");
    publish(&mut store, observation(2, None, false));
    assert_eq!(quota(&store, &id, ELAPSED)["state"], "waiting");
    assert!(poll(&mut store, 4, NOW, ELAPSED).is_empty());
    let changed = Binding {
        context_id: "c".repeat(64),
        account_fingerprint: "d".repeat(64),
    };
    publish(&mut store, observation(3, Some(changed.clone()), true));
    let (_, other) = queued(&mut store, "new-source-binding", spec(Some(&changed)));
    assert_eq!(quota(&store, &id, ELAPSED)["state"], "waiting");
    assert_eq!(poll(&mut store, 4, NOW, ELAPSED)[0].id, other);
}

#[test]
fn missing_incomplete_denied_and_expired_evidence_do_not_allocate_work() {
    let mut store = store();
    let (_, id) = queued(&mut store, "evidence", spec(Some(&binding())));
    assert!(poll(&mut store, 4, NOW, ELAPSED).is_empty());
    for (index, reason) in [
        "incomplete_snapshot",
        "backend_permission_unavailable",
        "window_reset_elapsed",
        "backend_denied",
    ]
    .into_iter()
    .enumerate()
    {
        let mut observed = observation(index as u64 + 1, Some(binding()), false);
        observed.reason = reason.into();
        publish(&mut store, observed);
        let view = quota(&store, &id, ELAPSED);
        assert_eq!(view["state"], "waiting");
        assert_eq!(view["reason"], reason);
        assert!(poll(&mut store, 4, NOW, ELAPSED).is_empty());
    }
    let mut observed = observation(5, Some(binding()), true);
    observed.expires_elapsed_ms = ELAPSED + 1;
    publish(&mut store, observed);
    assert!(poll(&mut store, 4, NOW, ELAPSED + 1).is_empty());
    assert_eq!(
        quota(&store, &id, ELAPSED + 1)["reason"],
        "observation_expired"
    );
    assert_eq!(count(&store, "harness_job_attempts"), 0);
}

#[test]
fn cancellation_is_unblocked_and_later_release_cannot_resurrect_queued_work() {
    let mut store = store();
    let (job, id) = queued(&mut store, "cancel-held", spec(Some(&binding())));
    let canceled = request(
        &mut store,
        json!({"action":"cancelOccurrence","key":"cancel-held","jobId":job,"occurrenceId":id}),
    )
    .unwrap();
    assert_eq!(canceled["occurrence"]["state"], "canceled");
    publish(&mut store, observation(1, Some(binding()), true));
    assert!(poll(&mut store, 4, NOW, ELAPSED).is_empty());
    code(
        request(
            &mut store,
            authorize(&job, &id, &binding(), &binding(), "authorize-canceled"),
        ),
        "occurrence_conflict",
    );
    assert_eq!(count(&store, "harness_job_attempts"), 0);
    assert_eq!(count(&store, "operation_receipts"), 0);
}

#[test]
fn recovery_deletes_evidence_and_requires_explicit_exact_owner_authorization() {
    let mut store = store();
    let (job, id) = queued(&mut store, "recover-held", spec(Some(&binding())));
    publish(&mut store, observation(1, Some(binding()), true));
    job_definitions::recover(&mut store.0, NOW + 1).unwrap();
    assert_eq!(count(&store, "harness_job_quota_sources"), 0);
    publish(&mut store, observation(1, Some(binding()), true));
    assert_eq!(
        quota(&store, &id, ELAPSED)["reason"],
        "owner_authorization_required"
    );
    assert!(poll(&mut store, 4, NOW + 1, ELAPSED).is_empty());
    let intent = authorize(
        &job,
        &id,
        &binding(),
        &binding(),
        "reauthorize-after-restart",
    );
    let accepted = request(&mut store, intent.clone()).unwrap();
    assert_eq!(accepted["occurrence"]["quota"]["state"], "eligible");
    assert_eq!(poll(&mut store, 4, NOW + 1, ELAPSED).len(), 1);
    assert_eq!(
        request(&mut store, intent).unwrap(),
        accepted,
        "Accepted replay precedes the post-claim state guard"
    );
    code(
        request(
            &mut store,
            authorize(&job, &id, &binding(), &binding(), "new-key-after-claim"),
        ),
        "occurrence_conflict",
    );
}

#[test]
fn authorization_compares_old_binding_and_does_not_rewrite_frozen_spec() {
    let mut store = store();
    let (job, id) = queued(&mut store, "authorize", spec(Some(&binding())));
    let original: String = store
        .0
        .query_row(
            "SELECT spec FROM harness_job_occurrences WHERE id=?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    let new = Binding {
        context_id: "c".repeat(64),
        account_fingerprint: "d".repeat(64),
    };
    publish(&mut store, observation(1, Some(new.clone()), true));
    let accepted = request(
        &mut store,
        authorize(&job, &id, &binding(), &new, "authorize-new"),
    )
    .unwrap();
    assert_eq!(accepted["occurrence"]["quota"]["contextId"], new.context_id);
    assert_eq!(
        accepted["occurrence"]["spec"]["quotaPolicy"],
        policy(&binding())
    );
    let retained: String = store
        .0
        .query_row(
            "SELECT spec FROM harness_job_occurrences WHERE id=?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(retained, original);
    code(
        request(
            &mut store,
            authorize(&job, &id, &binding(), &binding(), "stale-authorization"),
        ),
        "quota_binding_conflict",
    );
    let worker = Actor {
        issuer: "worker".into(),
        scope: Scope::Worker("native".into()),
    };
    code(
        job_definitions::execute_at(
            &mut store.0,
            worker,
            serde_json::from_value(authorize(&job, &id, &new, &new, "worker-authorize")).unwrap(),
            NOW,
            ELAPSED,
        ),
        "forbidden",
    );
}

#[test]
fn source_retention_never_evicts_and_existing_source_can_invalidate_when_full() {
    let mut store = store();
    for index in 0..64 {
        let mut observed = observation(1, Some(binding()), true);
        observed.source_id = format!("source-{index}");
        publish(&mut store, observed);
    }
    let mut extra = observation(1, Some(binding()), true);
    extra.source_id = "source-over-capacity".into();
    code(
        job_definitions::work_at(
            &mut store.0,
            Work::QuotaObserved { observation: extra },
            NOW,
            ELAPSED,
        ),
        "busy",
    );
    let mut invalidated = observation(2, None, false);
    invalidated.source_id = "source-0".into();
    publish(&mut store, invalidated);
    let row:(i64,Option<String>,bool)=store.0.query_row("SELECT revision,context_id,eligible FROM harness_job_quota_sources WHERE source_id='source-0'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(row, (2, None, false));
    assert_eq!(count(&store, "harness_job_quota_sources"), 64);
}

#[test]
fn malformed_newer_metadata_invalidates_permission_without_exposing_raw_error() {
    let mut store = store();
    let (_, id) = queued(&mut store, "safe-source", spec(Some(&binding())));
    publish(&mut store, observation(1, Some(binding()), true));
    let mut invalid = observation(2, Some(binding()), true);
    invalid.reason = "PRIVATE_PROVIDER_ERROR /private/home".into();
    publish(&mut store, invalid);
    let view = quota(&store, &id, ELAPSED);
    assert_eq!(view["state"], "waiting");
    assert_eq!(view["reason"], "invalid_observation");
    assert!(!view.to_string().contains("PRIVATE"));
    assert!(!view.to_string().contains("source_id"));
    assert!(!view.to_string().contains("expires_elapsed"));
}

#[test]
fn quota_policy_is_opt_in_strict_codex_only_and_preserves_legacy_fingerprints() {
    let original: job_definitions::Spec = serde_json::from_value(spec(None)).unwrap();
    let bytes = serde_json::to_string(&original).unwrap();
    let mut nullable: Value = serde_json::from_str(&bytes).unwrap();
    nullable["quotaPolicy"] = Value::Null;
    assert_eq!(
        serde_json::to_string(&serde_json::from_value::<job_definitions::Spec>(nullable).unwrap())
            .unwrap(),
        bytes
    );
    let mut unknown = spec(Some(&binding()));
    unknown["quotaPolicy"]["extra"] = json!(true);
    assert!(serde_json::from_value::<job_definitions::Spec>(unknown).is_err());
    let mut invalid = spec(Some(&binding()));
    invalid["quotaPolicy"]["contextId"] = json!("A".repeat(64));
    let mut store = store();
    code(
        request(
            &mut store,
            json!({"action":"create","key":"uppercase-policy","spec":invalid}),
        ),
        "invalid_argument",
    );
    let mut other = spec(Some(&binding()));
    other["profile"]["program"] = json!("claude");
    code(
        request(
            &mut store,
            json!({"action":"create","key":"wrong-provider","spec":other}),
        ),
        "unsupported",
    );
}

#[test]
fn exact_run_permit_is_readable_while_held_and_cancellation_invalidates_it() {
    let mut store = store();
    let (job, id) = queued(&mut store, "permit", spec(Some(&binding())));
    publish(&mut store, observation(1, Some(binding()), true));
    let claim = poll(&mut store, 1, NOW, ELAPSED).pop().unwrap();
    let run = "e".repeat(32);
    store.0.execute("INSERT INTO workflow_runs(id,title,goal,revision,state,created_at) VALUES(?1,'Permit','Metadata only',1,'active',?2)",params![run,i64::try_from(NOW).unwrap()]).unwrap();
    job_definitions::work_at(
        &mut store.0,
        Work::BindRun {
            dispatch: claim.dispatch,
            run: run.clone(),
        },
        NOW,
        ELAPSED,
    )
    .unwrap();
    let permit = job_quota::permit_for_run(&store.0, &run).unwrap().unwrap();
    assert_eq!(permit.occurrence_id, id);
    job_quota::guard_permit(&store.0, &permit, ELAPSED).unwrap();
    let guard = |store: &mut Store, now| {
        job_definitions::work_at(
            &mut store.0,
            Work::QuotaNativeGuard {
                permit: permit.clone(),
            },
            now,
            ELAPSED,
        )
    };
    assert!(matches!(guard(&mut store, NOW).unwrap(), Reply::Done));
    publish(&mut store, observation(2, Some(binding()), false));
    assert!(job_quota::permit_for_run(&store.0, &run).unwrap().is_some());
    code(
        job_quota::guard_permit(&store.0, &permit, ELAPSED),
        "quota_wait",
    );
    code(guard(&mut store, NOW), "quota_wait");
    store
        .0
        .execute(
            "UPDATE workflow_runs SET state='draining' WHERE id=?1",
            [&run],
        )
        .unwrap();
    code(guard(&mut store, NOW), "run_state_conflict");
    store
        .0
        .execute(
            "UPDATE workflow_runs SET state='active' WHERE id=?1",
            [&run],
        )
        .unwrap();
    store
        .0
        .execute(
            "INSERT INTO workflow_run_budget(run_id,limits,started_at) VALUES(?1,?2,?3)",
            params![
                run,
                json!({"maxParallel":1,"maxAttemptsPerTask":1,"maxElapsedMs":1000}).to_string(),
                i64::try_from(NOW).unwrap()
            ],
        )
        .unwrap();
    code(guard(&mut store, NOW + 1000), "time_budget_exhausted");
    store
        .0
        .execute(
            "UPDATE workflow_run_budget SET limits=?2 WHERE run_id=?1",
            params![
                run,
                json!({"maxParallel":1,"maxAttemptsPerTask":1,"maxElapsedMs":null}).to_string()
            ],
        )
        .unwrap();
    store.0.execute("INSERT INTO workflow_constraints(id,run_id,revision,text,issuer,created_at) VALUES('quota-constraint',?1,1,'Owner changed constraints','owner',?2)",params![run,i64::try_from(NOW).unwrap()]).unwrap();
    code(guard(&mut store, NOW + 1000), "constraints_changed");
    request(
        &mut store,
        json!({"action":"cancelOccurrence","key":"cancel-permit","jobId":job,"occurrenceId":id}),
    )
    .unwrap();
    code(
        job_quota::guard_permit(&store.0, &permit, ELAPSED),
        "job_canceled",
    );
    code(guard(&mut store, NOW + 1000), "job_canceled");
}

#[test]
fn precheck_and_run_binding_recheck_permission_without_starting_effects() {
    let mut store = store();
    let (_, id) = queued(&mut store, "phase-fences", spec(Some(&binding())));
    publish(&mut store, observation(1, Some(binding()), true));
    let claim = poll(&mut store, 1, NOW, ELAPSED).pop().unwrap();
    publish(&mut store, observation(2, Some(binding()), false));
    code(
        job_definitions::work_at(
            &mut store.0,
            Work::BeginPrecheck {
                dispatch: claim.dispatch.clone(),
            },
            NOW,
            ELAPSED,
        ),
        "quota_wait",
    );
    let create:Box<crate::orchestration::Request>=Box::new(serde_json::from_value(json!({"action":"create","key":"same-quota-run","spec":{"title":"Quota phase","goal":"No provider effects"}})).unwrap());
    code(
        job_definitions::work_at(
            &mut store.0,
            Work::Prepare {
                dispatch: claim.dispatch.clone(),
                request: create.clone(),
            },
            NOW,
            ELAPSED,
        ),
        "quota_wait",
    );
    assert_eq!(count(&store, "workflow_runs"), 0);
    publish(&mut store, observation(3, Some(binding()), true));
    let accepted = match job_definitions::work_at(
        &mut store.0,
        Work::Prepare {
            dispatch: claim.dispatch.clone(),
            request: create.clone(),
        },
        NOW,
        ELAPSED,
    )
    .unwrap()
    {
        Reply::Prepared(view) => view,
        _ => panic!("Expected one metadata run"),
    };
    publish(&mut store, observation(4, Some(binding()), false));
    code(
        job_definitions::work_at(
            &mut store.0,
            Work::Prepare {
                dispatch: claim.dispatch.clone(),
                request: create.clone(),
            },
            NOW,
            ELAPSED,
        ),
        "quota_wait",
    );
    assert_eq!(count(&store, "workflow_runs"), 1);
    publish(&mut store, observation(5, Some(binding()), true));
    let replay = match job_definitions::work_at(
        &mut store.0,
        Work::Prepare {
            dispatch: claim.dispatch.clone(),
            request: create,
        },
        NOW,
        ELAPSED,
    )
    .unwrap()
    {
        Reply::Prepared(view) => view,
        _ => panic!("Expected retained metadata run"),
    };
    assert_eq!(replay, accepted);
    publish(&mut store, observation(6, Some(binding()), false));
    let run = "e".repeat(32);
    store.0.execute("INSERT INTO workflow_runs(id,title,goal,revision,state,created_at) VALUES(?1,'Fence','Metadata only',1,'active',?2)",params![run,i64::try_from(NOW).unwrap()]).unwrap();
    code(
        job_definitions::work_at(
            &mut store.0,
            Work::BindRun {
                dispatch: claim.dispatch.clone(),
                run,
            },
            NOW,
            ELAPSED,
        ),
        "quota_wait",
    );
    let retained: Option<String> = store
        .0
        .query_row(
            "SELECT run_id FROM harness_job_occurrences WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, None);
    assert_eq!(count(&store, "harness_job_prechecks"), 0);
    assert_eq!(count(&store, "harness_job_generation_prechecks"), 0);
    assert_eq!(count(&store, "operation_receipts"), 0);
    crate::job_attempts::guard(&store.0, &claim.dispatch, &["dispatching"]).unwrap();
}

fn retry_source(store: &mut Store) -> (String, String, String) {
    let mut value = spec(Some(&binding()));
    value["retry"] =
        json!({"on":"launchNoEffect","maxAttempts":3,"initialDelayMs":1000,"maxDelayMs":2000});
    let (job, id) = queued(store, "retry-source", value);
    publish(store, observation(1, Some(binding()), true));
    let claim = poll(store, 1, NOW, ELAPSED).pop().unwrap();
    let run = "1".repeat(32);
    let task = "2".repeat(32);
    let native = "3".repeat(32);
    let receipt = "4".repeat(32);
    let session = "5".repeat(32);
    let key = format!("run-launch:{native}");
    let time = i64::try_from(NOW).unwrap();
    store.0.execute("INSERT INTO workflow_runs(id,title,goal,revision,state,created_at) VALUES(?1,'No-effect source','Recorded metadata only',1,'active',?2)",params![run,time]).unwrap();
    store.0.execute("INSERT INTO workflow_tasks(id,run_id,task_key,spec) VALUES(?1,?2,'job',?3)",params![task,run,json!({"key":"job","title":"Source","instruction":"Metadata only","dependencies":[]}).to_string()]).unwrap();
    store.0.execute("INSERT INTO workflow_attempts(id,task_id,ordinal,session_id,state) VALUES(?1,?2,1,?3,'launchFailed')",params![native,task,session]).unwrap();
    store.0.execute("INSERT INTO operation_receipts(id,issuer,key,digest,operation,phase,session_id,result) VALUES(?1,'owner',?2,'fixture','create','failed',?3,?4)",params![receipt,key,session,json!({"code":"invalid_launch","effectStarted":false}).to_string()]).unwrap();
    store.0.execute("INSERT INTO workflow_launches(attempt_id,operation_id,operation_key,workspace,created_at) VALUES(?1,?2,?3,'shared',?4)",params![native,receipt,key,time]).unwrap();
    store
        .0
        .execute(
            "INSERT INTO workflow_run_budget(run_id,limits,started_at) VALUES(?1,?2,?3)",
            params![
                run,
                json!({"maxParallel":1,"maxAttemptsPerTask":1,"maxElapsedMs":300000}).to_string(),
                time
            ],
        )
        .unwrap();
    store
        .0
        .execute(
            "UPDATE harness_job_occurrences SET run_id=?2,state='running' WHERE id=?1",
            params![id, run],
        )
        .unwrap();
    store
        .0
        .execute(
            "UPDATE harness_job_attempts SET run_id=?2,state='running' WHERE id=?1",
            params![claim.dispatch.attempt, run],
        )
        .unwrap();
    let tx = store.0.transaction().unwrap();
    assert!(crate::job_retries::consider(&tx, &id, NOW + 10).unwrap());
    tx.commit().unwrap();
    (job, id, claim.dispatch.attempt)
}

#[test]
fn held_retry_preserves_its_decision_and_reauthorization_does_not_replay_source() {
    let mut store = store();
    let (job, id, source) = retry_source(&mut store);
    let decision = crate::job_retries::view(&store.0, &source).unwrap();
    let old_generation = crate::job_attempts::view(&store.0, &job, &id, Some(&source), 0).unwrap();
    publish(&mut store, observation(2, Some(binding()), false));
    {
        let tx = store.0.transaction().unwrap();
        assert!(
            crate::job_retries::claim_at(&tx, &id, NOW + 2000, ELAPSED)
                .unwrap()
                .is_none(),
            "Direct retry admission also waits without changing its decision"
        );
        tx.commit().unwrap();
    }
    let (_, unrelated) = queued(&mut store, "retry-unrelated", spec(None));
    let claims = poll(&mut store, 1, NOW + 2000, ELAPSED);
    assert_eq!(
        claims[0].id, unrelated,
        "A held eligible-time retry cannot consume the SQL limit"
    );
    assert!(poll(&mut store, 4, NOW + 2000, ELAPSED).is_empty());
    assert_eq!(
        crate::job_retries::view(&store.0, &source).unwrap(),
        decision
    );
    assert_eq!(
        crate::job_attempts::view(&store.0, &job, &id, Some(&source), 0).unwrap(),
        old_generation
    );
    let waiting: (String, Option<String>) = store
        .0
        .query_row(
            "SELECT state,target_attempt_id FROM harness_job_retries WHERE source_attempt_id=?1",
            [&source],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(waiting, ("waiting".into(), None));

    let replacement = Binding {
        context_id: "c".repeat(64),
        account_fingerprint: "d".repeat(64),
    };
    publish(&mut store, observation(3, Some(replacement.clone()), true));
    request(
        &mut store,
        authorize(&job, &id, &binding(), &replacement, "retry-reauthorize"),
    )
    .unwrap();
    let next = poll(&mut store, 4, NOW + 2000, ELAPSED);
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].id, id);
    assert_eq!(next[0].ordinal, 2);
    assert_ne!(next[0].dispatch.attempt, source);
    assert_eq!(
        crate::job_retries::view(&store.0, &source).unwrap(),
        decision
    );
    assert_eq!(
        count(&store, "operation_receipts"),
        1,
        "Quota release cannot create or replay native receipts"
    );
}

#[test]
fn disk_reopen_preserves_accepted_bytes_and_pauses_unclaimed_quota_work() {
    struct Disk(std::path::PathBuf);
    impl Drop for Disk {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
            for suffix in ["-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
            }
        }
    }
    let disk = Disk(std::env::temp_dir().join(format!(
        "nesvo-job-quota-{}.sqlite",
        hex::encode(crate::wire::random::<16>())
    )));
    let (job, id, accepted) =
        {
            let mut store = Store::open(&disk.0).unwrap();
            let (job, id) = queued(&mut store, "disk", spec(Some(&binding())));
            publish(&mut store, observation(1, Some(binding()), true));
            let accepted: String = store.0.query_row(
            "SELECT view FROM harness_job_mutations WHERE issuer='owner' AND key='disk:now'",
            [], |r| r.get(0),
        ).unwrap();
            (job, id, accepted)
        };
    let mut reopened = Store::open(&disk.0).unwrap();
    assert_eq!(count(&reopened, "harness_job_quota_sources"), 0);
    assert_eq!(
        quota(&reopened, &id, ELAPSED)["reason"],
        "owner_authorization_required"
    );
    assert!(poll(&mut reopened, 4, NOW, ELAPSED).is_empty());
    let retained: String = reopened
        .0
        .query_row(
            "SELECT view FROM harness_job_mutations WHERE issuer='owner' AND key='disk:now'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(retained, accepted);
    let replay = request(&mut reopened, json!({"action":"mutation","key":"disk:now"})).unwrap();
    assert_eq!(replay, serde_json::from_str::<Value>(&accepted).unwrap());
    publish(&mut reopened, observation(1, Some(binding()), true));
    assert!(poll(&mut reopened, 4, NOW, ELAPSED).is_empty());
    request(
        &mut reopened,
        authorize(&job, &id, &binding(), &binding(), "disk-reauthorize"),
    )
    .unwrap();
    assert_eq!(poll(&mut reopened, 4, NOW, ELAPSED).len(), 1);
    assert_eq!(count(&reopened, "workflow_runs"), 0);
}

fn gate(revision: u64, program: &str, hold: Option<(&str, u64)>) -> Observation {
    Observation {
        source_id: format!("gate_{program}"),
        revision,
        binding: None,
        expires_elapsed_ms: hold.map_or(ELAPSED, |(_, expires)| expires),
        eligible: hold.is_none(),
        reason: hold.map_or("allow", |(reason, _)| reason).into(),
    }
}
fn program_spec(program: &str) -> Value {
    let mut value = spec(None);
    value["profile"]["program"] = program.into();
    value
}

#[test]
fn host_gate_hold_keeps_unpolicied_jobs_queued_until_a_newer_publication() {
    let mut store = store();
    let (_, codex) = queued(&mut store, "gate-codex", spec(None));
    let (_, claude) = queued(&mut store, "gate-claude", program_spec("claude"));
    publish(
        &mut store,
        gate(1, "codex", Some(("quota_exhausted", ELAPSED + 60_000))),
    );
    let held = quota(&store, &codex, ELAPSED);
    assert_eq!(held["state"], "held");
    assert_eq!(held["reason"], "quota_exhausted");
    assert!(held["resetsAt"].as_u64().is_some());
    code(
        job_quota::guard_gate(&store.0, crate::launchers::Program::Codex, ELAPSED),
        "quota_wait",
    );
    job_quota::guard_gate(&store.0, crate::launchers::Program::Claude, ELAPSED).unwrap();
    let claims = poll(&mut store, 4, NOW, ELAPSED);
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].id, claude);
    let untouched: (String, Option<String>) = store
        .0
        .query_row(
            "SELECT state,current_job_attempt_id FROM harness_job_occurrences WHERE id=?1",
            [&codex],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(untouched, ("queued".into(), None));
    let before = count(&store, "domain_events");
    publish(
        &mut store,
        gate(1, "codex", Some(("quota_exhausted", ELAPSED + 60_000))),
    );
    assert_eq!(count(&store, "domain_events"), before);
    assert!(poll(&mut store, 4, NOW, ELAPSED + 59_999).is_empty());
    publish(&mut store, gate(2, "codex", None));
    assert_eq!(quota(&store, &codex, ELAPSED)["state"], "notRequired");
    assert_eq!(poll(&mut store, 4, NOW, ELAPSED)[0].id, codex);
}

#[test]
fn host_gate_reset_expiry_releases_and_untimed_holds_have_no_reset() {
    let mut store = store();
    let (_, id) = queued(&mut store, "gate-expiry", program_spec("claude"));
    publish(
        &mut store,
        gate(1, "claude", Some(("quota_exhausted", ELAPSED + 5_000))),
    );
    assert!(poll(&mut store, 4, NOW, ELAPSED + 4_999).is_empty());
    assert_eq!(quota(&store, &id, ELAPSED + 5_000)["state"], "notRequired");
    publish(
        &mut store,
        gate(
            2,
            "claude",
            Some(("awaiting_observation", crate::quota_gate::UNTIMED_EXPIRY)),
        ),
    );
    let untimed = quota(&store, &id, ELAPSED + 5_000);
    assert_eq!(untimed["state"], "held");
    assert!(untimed["resetsAt"].is_null());
    let mut bound = gate(3, "claude", None);
    bound.binding = Some(binding());
    bound.expires_elapsed_ms = ELAPSED + 10_000;
    publish(&mut store, bound);
    assert_eq!(
        quota(&store, &id, ELAPSED)["reason"],
        "invalid_observation",
        "a gate row cannot carry configured-account authority"
    );
    publish(&mut store, gate(4, "claude", None));
    assert_eq!(poll(&mut store, 4, NOW, ELAPSED + 5_000)[0].id, id);
}

#[test]
fn configured_account_policy_is_unchanged_by_the_host_gate() {
    let mut store = store();
    let (_, id) = queued(&mut store, "gate-policy", spec(Some(&binding())));
    publish(
        &mut store,
        gate(1, "codex", Some(("quota_exhausted", ELAPSED + 60_000))),
    );
    assert_eq!(quota(&store, &id, ELAPSED)["state"], "waiting");
    publish(&mut store, observation(1, Some(binding()), true));
    assert_eq!(quota(&store, &id, ELAPSED)["state"], "eligible");
    assert_eq!(poll(&mut store, 4, NOW, ELAPSED)[0].id, id);
}

#[test]
fn restart_discards_gate_holds_and_keeps_per_occurrence_reauthorization() {
    let mut store = store();
    let (job, policy) = queued(&mut store, "restart-policy", spec(Some(&binding())));
    let (_, plain) = queued(&mut store, "restart-plain", program_spec("claude"));
    publish(
        &mut store,
        gate(1, "claude", Some(("quota_exhausted", ELAPSED + 60_000))),
    );
    publish(&mut store, observation(1, Some(binding()), true));
    job_definitions::recover(&mut store.0, NOW + 1).unwrap();
    assert_eq!(count(&store, "harness_job_quota_sources"), 0);
    assert_eq!(quota(&store, &plain, ELAPSED)["state"], "notRequired");
    publish(
        &mut store,
        gate(
            1,
            "claude",
            Some(("awaiting_observation", crate::quota_gate::UNTIMED_EXPIRY)),
        ),
    );
    publish(&mut store, observation(1, Some(binding()), true));
    assert_eq!(quota(&store, &plain, ELAPSED)["state"], "held");
    assert_eq!(
        quota(&store, &policy, ELAPSED)["reason"],
        "owner_authorization_required"
    );
    assert!(poll(&mut store, 4, NOW + 1, ELAPSED).is_empty());
    request(
        &mut store,
        authorize(&job, &policy, &binding(), &binding(), "restart-gate"),
    )
    .unwrap();
    assert_eq!(poll(&mut store, 4, NOW + 1, ELAPSED)[0].id, policy);
}
