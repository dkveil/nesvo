//! SQLite lifecycle evidence with an injected clock; these fixtures launch no process.
use super::Store;
use crate::{
    job_attempts::{self, Dispatch},
    job_cancellations,
    job_definitions::{self, Reply, Work},
    job_retries::{self, Policy},
    orchestration::{Actor, Scope},
};
use rusqlite::{Connection, TransactionBehavior, params};
use serde_json::{Value, json};

const NOW: u64 = 1_792_416_000_000;

fn sql_time(now: u64) -> i64 {
    i64::try_from(now).unwrap()
}

fn owner() -> Actor {
    Actor {
        issuer: "owner".into(),
        scope: Scope::Owner,
    }
}

pub(super) fn retry(max_attempts: u8) -> Value {
    json!({"on":"launchNoEffect","maxAttempts":max_attempts,"initialDelayMs":1000,"maxDelayMs":2500})
}

fn spec(policy: Option<Value>) -> Value {
    let mut spec = json!({
        "title":"Recorded validation refusal",
        "instruction":"No native process is launched by this SQLite fixture",
        "profile":{"program":"claude","workspace":"shared","harness":true},
        "schedule":{"kind":"once","at":chrono::DateTime::from_timestamp_millis((NOW+60_000) as i64).unwrap().to_rfc3339()},
        "overlap":"queue"
    });
    if let Some(policy) = policy {
        spec["retry"] = policy;
    }
    spec
}

fn store() -> Store {
    Store::open(std::path::Path::new(":memory:")).unwrap()
}

pub(super) struct Fixture {
    pub(super) job: String,
    pub(super) occurrence: String,
    pub(super) source: String,
    pub(super) run: String,
    pub(super) native: String,
    pub(super) receipt: String,
    pub(super) session: String,
}

fn native(connection: &Connection, prefix: &str) -> (String, String, String, String) {
    let run = format!("{prefix}-run");
    let task = format!("{prefix}-task");
    let attempt = format!("{prefix}-native");
    let receipt = format!("{prefix}-receipt");
    let session = format!("{prefix}-session");
    let key = format!("run-launch:{attempt}");
    connection.execute("INSERT INTO workflow_runs(id,title,goal,revision,state,created_at) VALUES(?1,'Recorded refusal','Metadata fixture',1,'active',?2)",params![run,sql_time(NOW)]).unwrap();
    connection.execute("INSERT INTO workflow_tasks(id,run_id,task_key,spec) VALUES(?1,?2,'job',?3)",params![task,run,json!({"key":"job","title":"Recorded refusal","instruction":"Metadata fixture","dependencies":[]}).to_string()]).unwrap();
    connection.execute("INSERT INTO workflow_attempts(id,task_id,ordinal,session_id,state) VALUES(?1,?2,1,?3,'launchFailed')",params![attempt,task,session]).unwrap();
    connection.execute("INSERT INTO operation_receipts(id,issuer,key,digest,operation,phase,session_id,result) VALUES(?1,'owner',?2,'retained-digest','create','failed',?3,?4)",params![receipt,key,session,json!({"code":"invalid_launch","message":"Recorded pre-native validation refusal","effectStarted":false}).to_string()]).unwrap();
    connection.execute("INSERT INTO workflow_launches(attempt_id,operation_id,operation_key,workspace,created_at) VALUES(?1,?2,?3,'shared',?4)",params![attempt,receipt,key,sql_time(NOW+2)]).unwrap();
    connection
        .execute(
            "INSERT INTO workflow_run_budget(run_id,limits,started_at) VALUES(?1,?2,?3)",
            params![
                run,
                json!({"maxParallel":1,"maxAttemptsPerTask":1,"maxElapsedMs":300000}).to_string(),
                sql_time(NOW + 1)
            ],
        )
        .unwrap();
    (run, attempt, receipt, session)
}

pub(super) fn seed(store: &Store, prefix: &str, policy: Option<Value>, ordinal: u16) -> Fixture {
    let (run, native, receipt, session) = native(&store.0, prefix);
    let job = format!("{prefix}-job");
    let occurrence = format!("{prefix}-occurrence");
    let source = format!("{prefix}-generation-{ordinal}");
    let spec = spec(policy).to_string();
    store
        .0
        .execute(
            "INSERT INTO harness_jobs(id,spec,revision,enabled,created_at) VALUES(?1,?2,1,0,?3)",
            params![job, spec, sql_time(NOW)],
        )
        .unwrap();
    store.0.execute("INSERT INTO harness_job_occurrences(id,job_id,job_revision,spec,trigger_key,trigger_kind,due_at,created_at,state,run_id,started_at) VALUES(?1,?2,1,?3,?1,'manual',?4,?4,'running',?5,?6)",params![occurrence,job,spec,sql_time(NOW),run,sql_time(NOW+1)]).unwrap();
    for prior in 1..=ordinal {
        store.0.execute("INSERT INTO harness_job_attempts(id,occurrence_id,ordinal,run_id,created_at,claimed_at,state,finished_at,dispatch_token) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![format!("{prefix}-generation-{prior}"),occurrence,prior,(prior==ordinal).then_some(&run),sql_time(NOW),sql_time(NOW+1),if prior==ordinal {"running"} else {"failed"},(prior<ordinal).then_some(sql_time(NOW+2)),(prior==ordinal).then_some("original-token")]).unwrap();
    }
    store
        .0
        .execute(
            "UPDATE harness_job_occurrences SET current_job_attempt_id=?2 WHERE id=?1",
            params![occurrence, source],
        )
        .unwrap();
    Fixture {
        job,
        occurrence,
        source,
        run,
        native,
        receipt,
        session,
    }
}

fn consider(store: &mut Store, fixture: &Fixture, now: u64) -> bool {
    let tx = store
        .0
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let accepted = job_retries::consider(&tx, &fixture.occurrence, now).unwrap();
    tx.commit().unwrap();
    accepted
}

pub(super) fn claim(store: &mut Store, fixture: &Fixture, now: u64) -> Option<(Dispatch, u16)> {
    let tx = store
        .0
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let claim = job_retries::claim(&tx, &fixture.occurrence, now).unwrap();
    tx.commit().unwrap();
    claim
}

fn changes(connection: &Connection) -> i64 {
    connection
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap()
}

fn count(connection: &Connection, table: &str) -> i64 {
    connection
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

fn generation(connection: &Connection, fixture: &Fixture) -> Value {
    job_attempts::view(
        connection,
        &fixture.job,
        &fixture.occurrence,
        Some(&fixture.source),
        0,
    )
    .unwrap()
}

fn occurrence(connection: &Connection, fixture: &Fixture) -> Value {
    job_definitions::occurrence(connection, &fixture.job, &fixture.occurrence, true).unwrap()
}

fn passed_precheck() -> Value {
    json!({"state":"passed","reason":"exit_code_passed","exitCode":0,"stdout":"retained command observation","stderr":"","stdoutTruncated":false,"stderrTruncated":false,"durationMs":1,"cleanupConfirmed":true,"commandStarted":true})
}

/// Retain real-shaped authorization and native refusal evidence without starting
/// either the approved command or a worker process.
fn prechecked_source(store: &mut Store, prefix: &str, ordinal: u16) -> (Fixture, String, String) {
    let fixture = seed(store, prefix, Some(retry(3)), ordinal);
    let command: crate::job_prechecks::Command = serde_json::from_value(json!({
        "title":"Explicitly repeatable fixture command",
        "executable":std::env::current_exe().unwrap(),
        "cwd":std::env::current_dir().unwrap(),
        "arguments":[],"environment":{}
    }))
    .unwrap();
    let digest = crate::job_prechecks::digest(&command).unwrap();
    let snapshot = serde_json::to_string(&command).unwrap();
    let approval = crate::job_prechecks::execute(
        &mut store.0,
        owner(),
        crate::job_prechecks::Request::Approve {
            key: format!("{prefix}-approve"),
            spec: command,
            expected_digest: digest.clone(),
        },
        NOW - 4,
    )
    .unwrap()["precheckApproval"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut checked = spec(Some(retry(3)));
    checked["precheckId"] = json!(approval);
    store
        .0
        .execute(
            "UPDATE harness_jobs SET spec=?2 WHERE id=?1",
            params![fixture.job, checked.to_string()],
        )
        .unwrap();
    store
        .0
        .execute(
            "UPDATE harness_job_occurrences SET spec=?2 WHERE id=?1",
            params![fixture.occurrence, checked.to_string()],
        )
        .unwrap();
    for generation in 1..=ordinal {
        if generation == 1 {
            store.0.execute("INSERT INTO harness_job_prechecks(occurrence_id,approval_id,approval_digest,spec,state,reason,started_at,finished_at,result,observed_at) VALUES(?1,?2,?3,?4,'passed','exit_code_passed',?5,?6,?7,?6)",params![fixture.occurrence,approval,digest,snapshot,sql_time(NOW-3),sql_time(NOW-2),passed_precheck().to_string()]).unwrap();
        } else {
            store.0.execute("INSERT INTO harness_job_generation_prechecks(job_attempt_id,occurrence_id,ordinal,approval_id,approval_digest,approval_revision,spec,state,reason,started_at,finished_at,result,observed_at) VALUES(?1,?2,?3,?4,?5,1,?6,'passed','exit_code_passed',?7,?8,?9,?8)",params![format!("{prefix}-generation-{generation}"),fixture.occurrence,generation,approval,digest,snapshot,sql_time(NOW-3),sql_time(NOW-2),passed_precheck().to_string()]).unwrap();
        }
    }
    (fixture, approval, digest)
}

#[test]
fn checked_retry_requires_its_own_snapshot_and_actual_boolean_command_evidence() {
    for ordinal in [1, 2] {
        let mut valid_store = store();
        let (valid, _, _) = prechecked_source(&mut valid_store, "checked-valid", ordinal);
        assert!(
            crate::job_precheck_records::passed_current(&valid_store.0, &valid.occurrence).unwrap()
        );
        assert!(consider(&mut valid_store, &valid, NOW + 3));
        assert_eq!(
            job_retries::view(&valid_store.0, &valid.source).unwrap()["nextOrdinal"],
            ordinal + 1
        );
        let table = if ordinal == 1 {
            "harness_job_prechecks"
        } else {
            "harness_job_generation_prechecks"
        };
        let mut mutations = vec![
            "spec=NULL",
            "spec='{}'",
            "approval_digest=NULL",
            "approval_digest='another-command-digest'",
            "approval_id='another-approval'",
            "state='unknown'",
            "finished_at=NULL",
            "result=NULL",
            "result='{}'",
            "result=json_set(result,'$.state','failed')",
        ];
        if ordinal > 1 {
            mutations.push("approval_revision=NULL");
        }
        for mutation in mutations {
            let mut store = store();
            let (fixture, _, _) = prechecked_source(&mut store, "checked-proof", ordinal);
            store
                .0
                .execute(&format!("UPDATE {table} SET {mutation}"), [])
                .unwrap();
            let before = changes(&store.0);
            assert!(
                !consider(&mut store, &fixture, NOW + 3),
                "Generation {ordinal}: {mutation}"
            );
            assert_eq!(changes(&store.0), before);
            assert_eq!(count(&store.0, "harness_job_retries"), 0);
        }
        for field in ["commandStarted", "cleanupConfirmed"] {
            for value in [
                None,
                Some(Value::Null),
                Some(json!(false)),
                Some(json!(1)),
                Some(json!("true")),
                Some(json!([])),
                Some(json!({})),
            ] {
                let mut store = store();
                let (fixture, _, _) = prechecked_source(&mut store, "checked-bools", ordinal);
                let mut result = passed_precheck();
                if let Some(value) = value {
                    result[field] = value;
                } else {
                    result.as_object_mut().unwrap().remove(field);
                }
                store
                    .0
                    .execute(
                        &format!("UPDATE {table} SET result=?1"),
                        [result.to_string()],
                    )
                    .unwrap();
                let before = changes(&store.0);
                assert!(
                    !consider(&mut store, &fixture, NOW + 3),
                    "Generation {ordinal}: {result}"
                );
                assert_eq!(changes(&store.0), before);
                assert_eq!(count(&store.0, "harness_job_retries"), 0);
            }
        }
    }
}

#[test]
fn an_older_generation_pass_cannot_prove_a_retry_for_the_current_generation() {
    let mut store = store();
    let (fixture, _, _) = prechecked_source(&mut store, "old-pass", 2);
    store
        .0
        .execute(
            "DELETE FROM harness_job_generation_prechecks WHERE job_attempt_id=?1",
            [&fixture.source],
        )
        .unwrap();
    assert_eq!(
        crate::job_precheck_records::view(&store.0, &fixture.occurrence, true).unwrap()["state"],
        "passed"
    );
    assert!(occurrence(&store.0, &fixture)["precheck"].is_null());
    let before = changes(&store.0);
    assert!(!consider(&mut store, &fixture, NOW + 3));
    assert_eq!(changes(&store.0), before);
    assert_eq!(count(&store.0, "harness_job_retries"), 0);
    assert_eq!(count(&store.0, "harness_job_attempts"), 2);
}

#[test]
fn checked_retry_claims_a_blank_generation_and_binds_only_after_its_own_command_pass() {
    let mut store = store();
    let (fixture, approval, digest) = prechecked_source(&mut store, "fresh-check", 1);
    assert!(consider(&mut store, &fixture, NOW + 3));
    let historical = generation(&store.0, &fixture);
    let (dispatch, ordinal) = claim(&mut store, &fixture, NOW + 1003).unwrap();
    assert_eq!(ordinal, 2);
    assert!(occurrence(&store.0, &fixture)["precheck"].is_null());
    assert!(occurrence(&store.0, &fixture)["runId"].is_null());
    assert_eq!(count(&store.0, "harness_job_generation_prechecks"), 0);
    assert!(!crate::job_precheck_records::passed_current(&store.0, &fixture.occurrence).unwrap());
    let (run, _, _, _) = native(&store.0, "fresh-check-second");
    let error = match job_definitions::work(
        &mut store.0,
        Work::BindRun {
            dispatch: dispatch.clone(),
            run: run.clone(),
        },
        NOW + 1004,
    ) {
        Err(error) => error,
        Ok(_) => panic!("A previous generation's pass cannot release this Run"),
    };
    assert_eq!(
        error
            .downcast_ref::<crate::api_error::Error>()
            .unwrap()
            .code,
        "precheck_required"
    );
    assert!(matches!(
        job_definitions::work(
            &mut store.0,
            Work::BeginPrecheck {
                dispatch: dispatch.clone()
            },
            NOW + 1005
        )
        .unwrap(),
        Reply::Precheck(Some(_))
    ));
    let running = occurrence(&store.0, &fixture)["precheck"].clone();
    assert_eq!(running["approvalId"], approval);
    assert_eq!(running["approvalDigest"], digest);
    assert_eq!(running["approvalRevision"], 1);
    assert_eq!(running["authorizedAt"], NOW + 1005);
    assert_eq!(running["state"], "running");
    assert!(running["result"].is_null());
    assert!(running["finishedAt"].is_null());
    assert!(!crate::job_precheck_records::passed_current(&store.0, &fixture.occurrence).unwrap());
    assert!(
        job_definitions::work(
            &mut store.0,
            Work::BindRun {
                dispatch: dispatch.clone(),
                run: run.clone()
            },
            NOW + 1006
        )
        .is_err()
    );
    assert!(matches!(
        job_definitions::work(
            &mut store.0,
            Work::FinishPrecheck {
                dispatch: dispatch.clone(),
                result: serde_json::from_value(passed_precheck()).unwrap()
            },
            NOW + 1007
        )
        .unwrap(),
        Reply::PrecheckPassed(true)
    ));
    assert!(crate::job_precheck_records::passed_current(&store.0, &fixture.occurrence).unwrap());
    assert!(matches!(
        job_definitions::work(
            &mut store.0,
            Work::BindRun {
                dispatch,
                run: run.clone()
            },
            NOW + 1008
        )
        .unwrap(),
        Reply::Done
    ));
    let current = occurrence(&store.0, &fixture);
    assert_eq!(current["runId"], run);
    assert_eq!(current["precheck"]["finishedAt"], NOW + 1007);
    assert_eq!(current["precheck"]["result"]["commandStarted"], true);
    assert_eq!(current["precheck"]["result"]["cleanupConfirmed"], true);
    assert_eq!(generation(&store.0, &fixture), historical);
    assert_eq!(count(&store.0, "harness_job_prechecks"), 1);
    assert_eq!(count(&store.0, "harness_job_generation_prechecks"), 1);
    assert!(job_attempts::guard_run(&store.0, &fixture.run).is_err());
}

#[test]
fn revoked_waiting_precheck_blocks_claim_but_known_clean_cancellation_still_completes() {
    let mut store = store();
    let (fixture, approval, _) = prechecked_source(&mut store, "revoke-waiting", 1);
    assert!(consider(&mut store, &fixture, NOW + 3));
    let historical = generation(&store.0, &fixture);
    let decision = job_retries::view(&store.0, &fixture.source).unwrap();
    crate::job_prechecks::execute(
        &mut store.0,
        owner(),
        crate::job_prechecks::Request::Revoke {
            key: "revoke-waiting-command".into(),
            id: approval,
            expected_revision: 1,
        },
        NOW + 4,
    )
    .unwrap();
    assert!(claim(&mut store, &fixture, NOW + 1003).is_none());
    assert_eq!(occurrence(&store.0, &fixture)["state"], "reconcile");
    assert_eq!(
        occurrence(&store.0, &fixture)["reason"],
        "retry_authority_changed"
    );
    assert_eq!(generation(&store.0, &fixture), historical);
    assert_eq!(
        job_retries::view(&store.0, &fixture.source).unwrap(),
        decision
    );
    assert_eq!(count(&store.0, "harness_job_attempts"), 1);
    let tx = store.0.transaction().unwrap();
    let canceled =
        job_cancellations::accept(&tx, &owner(), &fixture.job, &fixture.occurrence, NOW + 1004)
            .unwrap();
    assert_eq!(canceled["occurrence"]["state"], "canceled");
    assert_eq!(canceled["occurrence"]["cancellation"]["state"], "completed");
    tx.commit().unwrap();
    assert_eq!(generation(&store.0, &fixture), historical);
    assert!(claim(&mut store, &fixture, NOW + 5000).is_none());
    assert_eq!(count(&store.0, "harness_job_attempts"), 1);
    assert_eq!(count(&store.0, "workflow_controls"), 0);
    assert_eq!(count(&store.0, "operation_receipts"), 1);
}

#[test]
fn malformed_source_cleanup_blocks_both_due_retry_and_known_clean_cancellation() {
    for ordinal in [1, 2] {
        for cleanup in [Value::Null, json!(false), json!(1), json!("true")] {
            let mut store = store();
            let (fixture, _, _) = prechecked_source(&mut store, "cleanup-proof", ordinal);
            assert!(consider(&mut store, &fixture, NOW + 3));
            let mut result = passed_precheck();
            result["cleanupConfirmed"] = cleanup;
            let table = if ordinal == 1 {
                "harness_job_prechecks"
            } else {
                "harness_job_generation_prechecks"
            };
            store
                .0
                .execute(
                    &format!("UPDATE {table} SET result=?2 WHERE occurrence_id=?1"),
                    params![fixture.occurrence, result.to_string()],
                )
                .unwrap();
            let due = NOW + 3 + u64::from(ordinal) * 1000;
            assert!(claim(&mut store, &fixture, due).is_none());
            assert_eq!(
                occurrence(&store.0, &fixture)["reason"],
                "retry_evidence_changed"
            );
            let tx = store.0.transaction().unwrap();
            assert!(!job_retries::cancel_waiting(&tx, &fixture.occurrence, due + 1).unwrap());
            let canceled = job_cancellations::accept(
                &tx,
                &owner(),
                &fixture.job,
                &fixture.occurrence,
                due + 2,
            )
            .unwrap();
            assert_eq!(canceled["occurrence"]["state"], "canceling");
            assert_eq!(canceled["occurrence"]["cancellation"]["state"], "requested");
            assert!(canceled["occurrence"]["finishedAt"].is_null());
            tx.commit().unwrap();
            assert_eq!(count(&store.0, "harness_job_attempts"), i64::from(ordinal));
            assert_eq!(count(&store.0, "workflow_controls"), 0);
            assert_eq!(count(&store.0, "operation_receipts"), 1);
        }
    }
}

#[test]
fn host_abandon_request_preserves_legacy_bytes_when_generation_is_absent() {
    let legacy = r#"{"action":"abandonPrecheck","key":"abandon-once","jobId":"j","occurrenceId":"o","expectedDigest":"digest","acknowledgeUnknownEffects":true}"#;
    let request: job_definitions::Request = serde_json::from_str(legacy).unwrap();
    assert_eq!(serde_json::to_string(&request).unwrap(), legacy);
    let mut exact = serde_json::from_str::<Value>(legacy).unwrap();
    exact["jobAttemptId"] = json!("generation-2");
    let request: job_definitions::Request = serde_json::from_value(exact.clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), exact);
}

#[test]
fn policy_is_explicit_bounded_and_old_specs_keep_retry_absent() {
    let original = spec(None);
    let parsed: job_definitions::Spec = serde_json::from_value(original).unwrap();
    assert!(serde_json::to_value(parsed).unwrap().get("retry").is_none());
    for field in ["on", "maxAttempts", "initialDelayMs", "maxDelayMs"] {
        let mut value = retry(3);
        value.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<Policy>(value).is_err(),
            "Missing {field} is not defaulted"
        );
    }
    for (field, value) in [
        ("maxAttempts", json!(0)),
        ("maxAttempts", json!(9)),
        ("initialDelayMs", json!(999)),
        ("initialDelayMs", json!(3_600_001)),
        ("maxDelayMs", json!(999)),
        ("maxDelayMs", json!(86_400_001)),
    ] {
        let mut policy = retry(3);
        policy[field] = value;
        assert!(
            serde_json::from_value::<Policy>(policy)
                .unwrap()
                .validate()
                .is_err()
        );
    }
    for value in [
        json!({"on":"unknown","maxAttempts":3,"initialDelayMs":1000,"maxDelayMs":2500}),
        json!({"on":"launchNoEffect","maxAttempts":3,"initialDelayMs":1000,"maxDelayMs":2500,"extra":true}),
        json!({"on":"launchNoEffect","maxAttempts":3,"initialDelayMs":null,"maxDelayMs":2500}),
    ] {
        assert!(serde_json::from_value::<Policy>(value).is_err());
    }
    for value in [
        retry(1),
        json!({"on":"launchNoEffect","maxAttempts":8,"initialDelayMs":3_600_000,"maxDelayMs":86_400_000}),
    ] {
        let policy: Policy = serde_json::from_value(value.clone()).unwrap();
        policy.validate().unwrap();
        assert_eq!(serde_json::to_value(policy).unwrap(), value);
    }
    let mut store = store();
    let fixture = seed(&store, "default-off", None, 1);
    assert!(!consider(&mut store, &fixture, NOW + 3));
    assert_eq!(count(&store.0, "harness_job_retries"), 0);
    assert_eq!(occurrence(&store.0, &fixture)["state"], "running");
}

#[test]
fn backoff_doubles_from_the_failed_ordinal_and_caps_without_overflow() {
    let policy: Policy = serde_json::from_value(retry(8)).unwrap();
    let delays: Vec<_> = (1..=8)
        .map(|ordinal| policy.delay_ms(ordinal).unwrap())
        .collect();
    assert_eq!(delays, [1000, 2000, 2500, 2500, 2500, 2500, 2500, 2500]);
    let maximum: Policy = serde_json::from_value(json!({"on":"launchNoEffect","maxAttempts":8,"initialDelayMs":3_600_000,"maxDelayMs":86_400_000})).unwrap();
    assert_eq!(maximum.delay_ms(5).unwrap(), 57_600_000);
    assert_eq!(maximum.delay_ms(6).unwrap(), 86_400_000);
    assert_eq!(maximum.delay_ms(8).unwrap(), 86_400_000);
    assert!(policy.delay_ms(0).is_err());
    assert!(policy.delay_ms(9).is_err());
}

#[test]
fn first_decision_is_atomic_and_quiet_reads_never_extend_its_deadline() {
    let mut store = store();
    let fixture = seed(&store, "deadline", Some(retry(3)), 1);
    assert!(consider(&mut store, &fixture, NOW + 10));
    let decision = job_retries::view(&store.0, &fixture.source).unwrap();
    assert_eq!(
        decision,
        json!({"jobAttemptId":fixture.source,"attemptId":fixture.native,"launchReceiptId":fixture.receipt,"decidedAt":NOW+10,"notBefore":NOW+1010,"nextOrdinal":2,"class":"noEffect"})
    );
    let old = generation(&store.0, &fixture);
    assert_eq!(old["jobAttempt"]["state"], "failed");
    assert_eq!(old["jobAttempt"]["reason"], "launch_no_effect");
    assert_eq!(old["jobAttempt"]["finishedAt"], NOW + 10);
    let occurrence = occurrence(&store.0, &fixture);
    assert_eq!(occurrence["state"], "retryWaiting");
    assert_eq!(occurrence["reason"], "retry_backoff");
    assert_eq!(occurrence["startedAt"], NOW + 1);
    assert!(occurrence["finishedAt"].is_null());
    assert_eq!(count(&store.0, "domain_events"), 1);
    let before = changes(&store.0);
    assert!(consider(&mut store, &fixture, NOW - 100));
    assert!(consider(&mut store, &fixture, NOW + 100_000));
    assert!(claim(&mut store, &fixture, NOW + 1009).is_none());
    assert_eq!(
        job_retries::view(&store.0, &fixture.source).unwrap(),
        decision
    );
    assert_eq!(generation(&store.0, &fixture), old);
    assert_eq!(changes(&store.0), before);
    assert!(
        job_attempts::guard_run(&store.0, &fixture.run).is_err(),
        "The old Run is fenced during backoff, before the pointer advances"
    );
}

#[test]
fn retry_requires_the_actual_json_boolean_false_and_terminal_create_failure() {
    for (phase, result) in [
        ("failed", json!({"effectStarted":0})),
        ("failed", json!({"effectStarted":null})),
        ("failed", json!({"effectStarted":"false"})),
        ("failed", json!({"effectStarted":true})),
        ("failed", json!({})),
        (
            "failed",
            json!({"effectStarted":false,"taskResult":{"outcome":"succeeded"}}),
        ),
        (
            "unknown",
            json!({"effectStarted":false,"code":"launch_unconfirmed"}),
        ),
        ("unknown", json!({"code":"worktree_unconfirmed"})),
        ("created", json!({"effectStarted":false})),
        ("dispatching", json!({"effectStarted":false})),
    ] {
        let mut store = store();
        let fixture = seed(&store, "proof", Some(retry(3)), 1);
        store
            .0
            .execute(
                "UPDATE operation_receipts SET phase=?2,result=?3 WHERE id=?1",
                params![fixture.receipt, phase, result.to_string()],
            )
            .unwrap();
        let before = changes(&store.0);
        assert!(
            !consider(&mut store, &fixture, NOW + 3),
            "Refuse {phase} {result}"
        );
        assert_eq!(changes(&store.0), before);
        assert_eq!(count(&store.0, "harness_job_attempts"), 1);
        assert_eq!(count(&store.0, "domain_events"), 0);
    }
}

#[test]
fn launch_label_alone_never_overrides_results_bindings_or_conflicting_admission() {
    for mutation in [
        "UPDATE workflow_attempts SET state='launchUnknown'",
        "UPDATE workflow_attempts SET state='reported'",
        "UPDATE workflow_attempts SET result='{}'",
        "UPDATE workflow_attempts SET validation='{}'",
        "UPDATE operation_receipts SET operation='send'",
        "UPDATE operation_receipts SET session_id='another-session'",
        "UPDATE operation_receipts SET key='another-key'",
        "UPDATE operation_receipts SET claim_token='still-owned'",
        "DELETE FROM workflow_launches",
        "INSERT INTO workflow_tasks(id,run_id,task_key,spec) VALUES('second-task','binding-run','other','{}')",
        "INSERT INTO workflow_attempts(id,task_id,ordinal,session_id,state) VALUES('later-native','binding-task',2,'later-session','launchFailed')",
        "INSERT INTO harness_job_attempts(id,occurrence_id,ordinal,created_at,state) VALUES('later-generation','binding-occurrence',2,0,'dispatching')",
        "UPDATE harness_job_occurrences SET run_id=NULL",
    ] {
        let mut store = store();
        let fixture = seed(&store, "binding", Some(retry(3)), 1);
        store.0.execute_batch(mutation).unwrap();
        assert!(
            !consider(&mut store, &fixture, NOW + 3),
            "Refuse conflicting evidence: {mutation}"
        );
        assert_eq!(count(&store.0, "harness_job_retries"), 0);
        assert_eq!(count(&store.0, "domain_events"), 0);
    }
}

#[test]
fn cancellation_control_drain_delivery_and_exit_evidence_all_refuse_retry() {
    for mutation in [
        "INSERT INTO harness_job_cancellations(occurrence_id,issuer,state,requested_at,observed_at,control_key) VALUES('authority-occurrence','owner','requested',0,0,'cancel-key')",
        "INSERT INTO workflow_controls(id,run_id,kind,issuer,state,created_at) VALUES('control','authority-run','stop','owner','completed',0)",
        "UPDATE workflow_runs SET state='drained'",
        "UPDATE workflow_run_budget SET drain_owner=1",
        "UPDATE workflow_run_budget SET limits=json_set(limits,'$.maxElapsedMs',1000)",
        "INSERT INTO workflow_constraints(id,run_id,revision,text,issuer,created_at) VALUES('constraint','authority-run',1,'Owner changed the required work','owner',0)",
        "INSERT INTO workflow_coordinator_bindings(run_id,coordinator_id,directory,generation,source,updated_at) VALUES('authority-run','new-coordinator','fixture-directory',1,'unbound',0)",
        "INSERT INTO workflow_deliveries(id,run_id,attempt_id,issuer,phase,created_at,deadline_at) VALUES('delivery','authority-run','authority-native','owner','canceled',0,1)",
        "INSERT INTO workflow_process_exits(session_id,observed_at) VALUES('authority-session',0)",
        "INSERT INTO operation_receipts(id,issuer,key,digest,operation,phase,session_id,result) VALUES('send','owner','other-native-key','digest','send','accepted','authority-session','{}')",
        "INSERT INTO workflow_executors(id,run_id,spec,issuer,enabled,generation,phase,created_at) VALUES('disabled','authority-run','{}','owner',0,2,'disabled',0)",
        "UPDATE harness_job_occurrences SET spec=json_set(spec,'$.precheckId','historical-approval')",
        "INSERT INTO harness_job_prechecks(occurrence_id,approval_id,approval_digest,state,reason,started_at,observed_at) VALUES('authority-occurrence','approval','digest','passed','retained',0,0)",
    ] {
        let mut store = store();
        let fixture = seed(&store, "authority", Some(retry(3)), 1);
        store.0.execute_batch(mutation).unwrap();
        assert!(
            !consider(&mut store, &fixture, NOW + 3),
            "Refuse: {mutation}"
        );
        assert_eq!(count(&store.0, "harness_job_retries"), 0);
    }
}

#[test]
fn due_claim_uses_a_fresh_generation_and_keeps_original_keys_bodies_and_times() {
    let mut store = store();
    let fixture = seed(&store, "claim", Some(retry(3)), 1);
    let accepted = "{\n  \"occurrence\": {\"id\":\"claim-occurrence\",\"state\":\"queued\"}\n}";
    store.0.execute("INSERT INTO harness_job_mutations(issuer,key,digest,view) VALUES('owner','original-key','original-digest',?1)",[accepted]).unwrap();
    assert!(consider(&mut store, &fixture, NOW + 3));
    let old = generation(&store.0, &fixture);
    let decision = job_retries::view(&store.0, &fixture.source).unwrap();
    let (dispatch, ordinal) = claim(&mut store, &fixture, NOW + 1003).unwrap();
    assert_eq!(ordinal, 2);
    assert_ne!(dispatch.attempt, fixture.source);
    assert_ne!(dispatch.token, "original-token");
    assert_eq!(dispatch.token.len(), 64);
    job_attempts::guard(&store.0, &dispatch, &["dispatching"]).unwrap();
    assert_eq!(generation(&store.0, &fixture), old);
    assert_eq!(
        job_retries::view(&store.0, &fixture.source).unwrap(),
        decision
    );
    let current = occurrence(&store.0, &fixture);
    assert_eq!(current["jobAttemptId"], dispatch.attempt);
    assert_eq!(current["jobAttemptOrdinal"], 2);
    assert_eq!(current["state"], "dispatching");
    assert_eq!(current["startedAt"], NOW + 1);
    assert!(current["runId"].is_null());
    assert!(current["finishedAt"].is_null());
    let next = job_attempts::view(
        &store.0,
        &fixture.job,
        &fixture.occurrence,
        Some(&dispatch.attempt),
        0,
    )
    .unwrap();
    assert_eq!(next["jobAttempt"]["createdAt"], NOW + 1003);
    assert_eq!(next["jobAttempt"]["claimedAt"], NOW + 1003);
    assert!(next["jobAttempt"]["attemptId"].is_null());
    assert!(next["jobAttempt"]["result"].is_null());
    let stored: (String, String) = store
        .0
        .query_row(
            "SELECT digest,view FROM harness_job_mutations WHERE key='original-key'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(stored, ("original-digest".into(), accepted.into()));
    let before = changes(&store.0);
    assert!(claim(&mut store, &fixture, NOW + 5000).is_none());
    assert_eq!(changes(&store.0), before);
    assert_eq!(
        count(&store.0, "workflow_attempts"),
        1,
        "Claiming creates metadata only"
    );
    assert_eq!(count(&store.0, "operation_receipts"), 1);
}

#[test]
fn admission_revalidates_evidence_and_authority_and_blocks_without_rewriting_failure() {
    for (mutation, reason) in [
        (
            "UPDATE operation_receipts SET result='{}'",
            "retry_evidence_changed",
        ),
        (
            "UPDATE workflow_attempts SET result='{}'",
            "retry_evidence_changed",
        ),
        (
            "UPDATE harness_job_occurrences SET run_id=NULL",
            "retry_evidence_changed",
        ),
        (
            "UPDATE workflow_run_budget SET drain_owner=1",
            "retry_authority_changed",
        ),
        (
            "UPDATE workflow_run_budget SET limits=json_set(limits,'$.maxElapsedMs',1000)",
            "retry_authority_changed",
        ),
        (
            "INSERT INTO workflow_constraints(id,run_id,revision,text,issuer,created_at) VALUES('constraint','blocked-run',1,'Owner changed the required work','owner',0)",
            "retry_authority_changed",
        ),
        (
            "INSERT INTO workflow_coordinator_bindings(run_id,coordinator_id,directory,generation,source,updated_at) VALUES('blocked-run','new-coordinator','fixture-directory',1,'unbound',0)",
            "retry_authority_changed",
        ),
        (
            "UPDATE workflow_runs SET state='stopped'",
            "retry_authority_changed",
        ),
        (
            "INSERT INTO workflow_controls(id,run_id,kind,issuer,state,created_at) VALUES('stop','blocked-run','stop','owner','completed',0)",
            "retry_authority_changed",
        ),
        (
            "UPDATE harness_job_occurrences SET spec=json_set(spec,'$.retry.maxAttempts',1)",
            "retry_policy_changed",
        ),
    ] {
        let mut store = store();
        let fixture = seed(&store, "blocked", Some(retry(3)), 1);
        assert!(consider(&mut store, &fixture, NOW + 3));
        let old = generation(&store.0, &fixture);
        let decision = job_retries::view(&store.0, &fixture.source).unwrap();
        store.0.execute_batch(mutation).unwrap();
        assert!(
            claim(&mut store, &fixture, NOW + 1003).is_none(),
            "Refuse: {mutation}"
        );
        assert_eq!(occurrence(&store.0, &fixture)["state"], "reconcile");
        assert_eq!(occurrence(&store.0, &fixture)["reason"], reason);
        assert_eq!(
            job_retries::view(&store.0, &fixture.source).unwrap(),
            decision
        );
        // Native evidence changed deliberately above; the generation's own
        // failed state, first finish and dispatch claim must remain unchanged.
        let retained = generation(&store.0, &fixture);
        for key in [
            "id",
            "state",
            "reason",
            "createdAt",
            "claimedAt",
            "finishedAt",
            "retry",
        ] {
            assert_eq!(retained["jobAttempt"][key], old["jobAttempt"][key]);
        }
        assert_eq!(count(&store.0, "harness_job_attempts"), 1);
        let before = changes(&store.0);
        assert!(claim(&mut store, &fixture, NOW + 5000).is_none());
        assert_eq!(changes(&store.0), before);
    }
}

#[test]
fn total_attempt_limit_includes_generation_one_and_every_retry_waits_its_own_delay() {
    let mut store = store();
    let mut fixture = seed(&store, "limit", Some(retry(3)), 1);
    for (source_ordinal, decision_at, delay) in [(1, NOW + 3, 1000), (2, NOW + 2003, 2000)] {
        assert!(consider(&mut store, &fixture, decision_at));
        assert_eq!(
            job_retries::view(&store.0, &fixture.source).unwrap()["notBefore"],
            decision_at + delay
        );
        assert!(claim(&mut store, &fixture, decision_at + delay - 1).is_none());
        let (dispatch, ordinal) = claim(&mut store, &fixture, decision_at + delay).unwrap();
        assert_eq!(ordinal, source_ordinal + 1);
        let (run, native, receipt, session) = native(&store.0, &format!("limit-{ordinal}"));
        store.0.execute("UPDATE harness_job_attempts SET run_id=?2,state='running',dispatch_token=NULL WHERE id=?1",params![dispatch.attempt,run]).unwrap();
        store
            .0
            .execute(
                "UPDATE harness_job_occurrences SET run_id=?2,state='running' WHERE id=?1",
                params![fixture.occurrence, run],
            )
            .unwrap();
        fixture.source = dispatch.attempt;
        fixture.run = run;
        fixture.native = native;
        fixture.receipt = receipt;
        fixture.session = session;
    }
    assert!(!consider(&mut store, &fixture, NOW + 5000));
    assert_eq!(count(&store.0, "harness_job_attempts"), 3);
    assert_eq!(count(&store.0, "harness_job_retries"), 2);
    for max in [1, 8] {
        let fixture = seed(
            &store,
            &format!("exhausted-{max}"),
            Some(retry(max)),
            u16::from(max),
        );
        assert!(!consider(&mut store, &fixture, NOW + 10_000));
    }
}

#[test]
fn owner_backoff_cancellation_is_logical_and_preserves_the_failed_generation() {
    let mut store = store();
    let fixture = seed(&store, "cancel", Some(retry(3)), 1);
    assert!(consider(&mut store, &fixture, NOW + 3));
    let old = generation(&store.0, &fixture);
    let tx = store.0.transaction().unwrap();
    let canceled =
        job_cancellations::accept(&tx, &owner(), &fixture.job, &fixture.occurrence, NOW + 4)
            .unwrap();
    assert_eq!(canceled["occurrence"]["state"], "canceled");
    tx.commit().unwrap();
    assert_eq!(generation(&store.0, &fixture), old);
    assert_eq!(occurrence(&store.0, &fixture)["finishedAt"], NOW + 4);
    assert_eq!(count(&store.0, "workflow_controls"), 0);
    assert_eq!(count(&store.0, "operation_receipts"), 1);
    assert!(claim(&mut store, &fixture, NOW + 1003).is_none());
    assert_eq!(count(&store.0, "harness_job_attempts"), 1);
}

#[test]
fn cancel_waiting_only_updates_decision_and_can_cancel_blocked_owner_metadata() {
    let mut store = store();
    let fixture = seed(&store, "cancel-blocked", Some(retry(3)), 1);
    assert!(consider(&mut store, &fixture, NOW + 3));
    store
        .0
        .execute("UPDATE workflow_runs SET state='stopped'", [])
        .unwrap();
    store.0.execute("INSERT INTO workflow_controls(id,run_id,kind,issuer,state,created_at) VALUES('stop',?1,'stop','owner','completed',?2)",params![fixture.run,sql_time(NOW+4)]).unwrap();
    assert!(claim(&mut store, &fixture, NOW + 1003).is_none());
    let old = generation(&store.0, &fixture);
    let before = occurrence(&store.0, &fixture);
    let events = count(&store.0, "domain_events");
    let tx = store.0.transaction().unwrap();
    assert!(job_retries::cancel_waiting(&tx, &fixture.occurrence, NOW + 1004).unwrap());
    assert!(!job_retries::cancel_waiting(&tx, &fixture.occurrence, NOW + 1005).unwrap());
    tx.commit().unwrap();
    assert_eq!(occurrence(&store.0, &fixture), before);
    assert_eq!(generation(&store.0, &fixture), old);
    assert_eq!(count(&store.0, "domain_events"), events);
    assert!(claim(&mut store, &fixture, NOW + 5000).is_none());

    let other = seed(&store, "cancel-unsafe", Some(retry(3)), 1);
    assert!(consider(&mut store, &other, NOW + 3));
    store
        .0
        .execute(
            "INSERT INTO workflow_process_exits(session_id,observed_at) VALUES(?1,?2)",
            params![other.session, sql_time(NOW + 4)],
        )
        .unwrap();
    let tx = store.0.transaction().unwrap();
    assert!(!job_retries::cancel_waiting(&tx, &other.occurrence, NOW + 5).unwrap());
    tx.commit().unwrap();
}

#[test]
fn rollback_discards_decisions_and_claims_without_leaving_a_replacement_token() {
    let mut store = store();
    let fixture = seed(&store, "rollback", Some(retry(3)), 1);
    let original = generation(&store.0, &fixture);
    {
        let tx = store.0.transaction().unwrap();
        assert!(job_retries::consider(&tx, &fixture.occurrence, NOW + 3).unwrap());
    }
    assert_eq!(generation(&store.0, &fixture), original);
    assert_eq!(count(&store.0, "domain_events"), 0);
    assert_eq!(count(&store.0, "harness_job_retries"), 0);
    assert!(consider(&mut store, &fixture, NOW + 4));
    let retired;
    {
        let tx = store.0.transaction().unwrap();
        retired = job_retries::claim(&tx, &fixture.occurrence, NOW + 1004)
            .unwrap()
            .unwrap()
            .0;
    }
    assert_eq!(count(&store.0, "harness_job_attempts"), 1);
    assert_eq!(occurrence(&store.0, &fixture)["state"], "retryWaiting");
    let (fresh, _) = claim(&mut store, &fixture, NOW + 1004).unwrap();
    assert_ne!(fresh.attempt, retired.attempt);
    assert_ne!(fresh.token, retired.token);
    assert!(job_attempts::guard(&store.0, &retired, &["dispatching"]).is_err());
    job_attempts::guard(&store.0, &fresh, &["dispatching"]).unwrap();
}

fn queued(store: &Store, job: &str, id: &str, created_at: u64) {
    let spec = spec(None).to_string();
    let created_at = sql_time(created_at);
    store.0.execute("INSERT OR IGNORE INTO harness_jobs(id,spec,revision,enabled,created_at) VALUES(?1,?2,1,0,?3)",params![job,spec,created_at]).unwrap();
    store.0.execute("INSERT INTO harness_job_occurrences(id,job_id,job_revision,spec,trigger_key,trigger_kind,due_at,created_at,state) VALUES(?1,?2,1,?3,?1,'manual',?4,?4,'queued')",params![id,job,spec,created_at]).unwrap();
}

#[test]
fn accepting_retry_retires_the_source_executor_once_and_keeps_the_due_claim_eligible() {
    let mut store = store();
    let fixture = seed(&store, "retire-pump", Some(retry(3)), 1);
    store.0.execute("INSERT INTO workflow_executors(id,run_id,spec,issuer,enabled,generation,phase,task_id,created_at) VALUES('source-pump',?1,'{\"tasks\":[]}', 'owner',1,4,'blocked','retire-pump-task',0)", [&fixture.run]).unwrap();
    assert!(consider(&mut store, &fixture, NOW + 3));
    let retired:(bool,i64,String,String,Option<String>) = store.0.query_row("SELECT enabled,generation,phase,reason,task_id FROM workflow_executors WHERE id='source-pump'", [], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
    assert_eq!(
        retired,
        (false, 5, "paused".into(), "job_retry_waiting".into(), None)
    );
    let events = count(&store.0, "domain_events");
    assert_eq!(
        events, 2,
        "Executor retirement and retry decision each publish one event"
    );
    assert!(consider(&mut store, &fixture, NOW + 4));
    assert_eq!(count(&store.0, "domain_events"), events);
    let active: i64 = store
        .0
        .query_row(
            "SELECT count(*) FROM workflow_executors WHERE enabled=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        active, 0,
        "Historical pumps cannot exhaust executor capacity"
    );
    let guard = crate::workflow_executor::Guard {
        id: "source-pump".into(),
        generation: 4,
    };
    assert!(matches!(
        crate::workflow_executor::execute(
            &mut store.0,
            crate::workflow_executor::Work::Poll {
                guard: guard.clone(),
                issuer: "owner".into()
            },
            NOW + 5
        )
        .unwrap(),
        crate::workflow_executor::Reply::Snapshot(None)
    ));
    assert!(claim(&mut store, &fixture, NOW + 1003).is_some());
}

fn poll(store: &mut Store, now: u64) -> Vec<job_definitions::Claim> {
    match job_definitions::work(&mut store.0, Work::Poll { slots: 1 }, now).unwrap() {
        Reply::Claims(claims) => claims,
        _ => panic!("Expected scheduler claims"),
    }
}

#[test]
fn scheduler_shares_fair_eligibility_order_and_keeps_overlap_active_during_backoff() {
    let mut store = store();
    let fixture = seed(&store, "fair", Some(retry(3)), 1);
    assert!(consider(&mut store, &fixture, NOW + 3));
    queued(&store, &fixture.job, "same-job-follower", NOW + 4);
    assert!(poll(&mut store, NOW + 1002).is_empty());
    queued(&store, "fresh-job", "fresh-earlier", NOW + 500);
    let fresh = poll(&mut store, NOW + 1003);
    assert_eq!(fresh.len(), 1);
    assert_eq!(
        fresh[0].id, "fresh-earlier",
        "A retry uses its eligibility deadline, not its old occurrence creation time"
    );
    queued(&store, "late-job", "fresh-later", NOW + 1500);
    let retry = poll(&mut store, NOW + 2000);
    assert_eq!(retry.len(), 1);
    assert_eq!(retry[0].id, fixture.occurrence);
    assert_ne!(retry[0].dispatch.attempt, fixture.source);
    let follower: String = store
        .0
        .query_row(
            "SELECT state FROM harness_job_occurrences WHERE id='same-job-follower'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(follower, "queued");
}

#[test]
fn full_generation_retention_refuses_due_claim_without_consuming_retry_intent() {
    let mut store = store();
    let fixture = seed(&store, "capacity", Some(retry(3)), 1);
    assert!(consider(&mut store, &fixture, NOW + 3));
    for group in 0..8 {
        queued(&store, "retention-job", &format!("retention-{group}"), NOW);
    }
    store.0.execute_batch("WITH RECURSIVE retained(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM retained WHERE n<32767) INSERT INTO harness_job_attempts(id,occurrence_id,ordinal,created_at,state) SELECT 'retained-'||n,'retention-'||((n-1)/4096),((n-1)%4096)+1,0,'failed' FROM retained;").unwrap();
    assert_eq!(count(&store.0, "harness_job_attempts"), 32768);
    let old = generation(&store.0, &fixture);
    let tx = store.0.transaction().unwrap();
    let error = match job_retries::claim(&tx, &fixture.occurrence, NOW + 1003) {
        Err(error) => error,
        Ok(_) => panic!("Expected retained generation capacity to refuse admission"),
    };
    assert_eq!(
        error
            .downcast_ref::<crate::api_error::Error>()
            .unwrap()
            .code,
        "busy"
    );
    tx.commit().unwrap();
    assert_eq!(generation(&store.0, &fixture), old);
    assert_eq!(occurrence(&store.0, &fixture)["state"], "retryWaiting");
    assert_eq!(
        store
            .0
            .query_row(
                "SELECT state FROM harness_job_retries WHERE source_attempt_id=?1",
                [fixture.source],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "waiting"
    );
}

#[test]
fn competing_writers_cannot_cancel_or_duplicate_an_already_claimed_retry() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-job-retry-race-{}.sqlite",
        hex::encode(crate::wire::random::<8>())
    ));
    {
        let mut store = Store::open(&path).unwrap();
        let fixture = seed(&store, "race", Some(retry(3)), 1);
        assert!(consider(&mut store, &fixture, NOW + 3));
        let mut second = Connection::open(&path).unwrap();
        second
            .busy_timeout(std::time::Duration::from_millis(1))
            .unwrap();
        second.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let tx = store
            .0
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let (winner, _) = job_retries::claim(&tx, &fixture.occurrence, NOW + 1003)
            .unwrap()
            .unwrap();
        assert!(
            second
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .is_err()
        );
        tx.commit().unwrap();
        let tx = second
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert!(
            job_retries::claim(&tx, &fixture.occurrence, NOW + 1003)
                .unwrap()
                .is_none()
        );
        assert!(!job_retries::cancel_waiting(&tx, &fixture.occurrence, NOW + 1003).unwrap());
        tx.commit().unwrap();
        job_attempts::guard(&store.0, &winner, &["dispatching"]).unwrap();
        assert_eq!(count(&store.0, "harness_job_attempts"), 2);
    }
    std::fs::remove_file(path).unwrap();
}

#[test]
fn reopen_preserves_waiting_deadline_and_interrupted_claim_never_mints_another_token() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-job-retry-reopen-{}.sqlite",
        hex::encode(crate::wire::random::<8>())
    ));
    let fixture;
    let decision;
    let old;
    {
        let mut store = Store::open(&path).unwrap();
        fixture = seed(&store, "reopen", Some(retry(3)), 1);
        assert!(consider(&mut store, &fixture, NOW + 3));
        decision = job_retries::view(&store.0, &fixture.source).unwrap();
        old = generation(&store.0, &fixture);
    }
    let dispatched;
    {
        let mut store = Store::open(&path).unwrap();
        assert_eq!(
            job_retries::view(&store.0, &fixture.source).unwrap(),
            decision
        );
        assert_eq!(generation(&store.0, &fixture), old);
        assert_eq!(occurrence(&store.0, &fixture)["state"], "retryWaiting");
        assert_eq!(count(&store.0, "harness_job_attempts"), 1);
        let tokens: i64 = store
            .0
            .query_row(
                "SELECT count(*) FROM harness_job_attempts WHERE dispatch_token IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tokens, 0);
        dispatched = claim(&mut store, &fixture, NOW + 1003).unwrap().0;
    }
    {
        let mut store = Store::open(&path).unwrap();
        assert_eq!(
            job_retries::view(&store.0, &fixture.source).unwrap(),
            decision
        );
        assert_eq!(generation(&store.0, &fixture), old);
        assert_eq!(count(&store.0, "harness_job_attempts"), 2);
        assert_eq!(
            occurrence(&store.0, &fixture)["jobAttemptId"],
            dispatched.attempt
        );
        assert_eq!(occurrence(&store.0, &fixture)["state"], "retryWaiting");
        assert_eq!(
            occurrence(&store.0, &fixture)["reason"],
            "retry_probe_pending"
        );
        assert!(
            job_retries::view(&store.0, &dispatched.attempt)
                .unwrap()
                .is_null()
        );
        assert!(claim(&mut store, &fixture, NOW + 5000).is_none());
        assert!(job_attempts::guard(&store.0, &dispatched, &["dispatching"]).is_err());
        assert_eq!(count(&store.0, "harness_job_attempts"), 2);
        let probed = job_retries::view(&store.0, &dispatched.attempt).unwrap();
        assert_eq!(probed["class"], "uncertainEffect");
        assert_eq!(probed["probe"]["result"], "absent");
        assert_eq!(probed["probe"]["runId"], Value::Null);
        assert_eq!(probed["decidedAt"], NOW + 5000);
        assert_eq!(probed["notBefore"], NOW + 7000);
        assert_eq!(probed["nextOrdinal"], 3);
        let current = occurrence(&store.0, &fixture);
        assert_eq!(current["state"], "retryWaiting");
        assert_eq!(current["reason"], "retry_backoff");
        assert_eq!(current["retry"], probed);
        let record = &job_attempts::view(
            &store.0,
            &fixture.job,
            &fixture.occurrence,
            Some(&dispatched.attempt),
            0,
        )
        .unwrap()["jobAttempt"];
        assert_eq!(record["state"], "failed");
        assert_eq!(record["reason"], "launch_no_effect");
        assert_eq!(record["retryClassification"]["failure"], "host_restarted");
        assert_eq!(
            record["retryClassification"]["launchKey"],
            format!(
                "job:{}:{}:attempt:2:executor",
                fixture.job, fixture.occurrence
            )
        );
        assert_eq!(
            record["retryAdmission"]["sourceJobAttemptId"],
            fixture.source
        );
        let tokens: i64 = store
            .0
            .query_row(
                "SELECT count(*) FROM harness_job_attempts WHERE dispatch_token IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tokens, 0);
    }
    std::fs::remove_file(path).unwrap();
}

pub(super) fn fail(store: &mut Store, fixture: &Fixture, reason: &str, now: u64) {
    let tx = store
        .0
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    job_definitions::transition(
        &tx,
        &fixture.occurrence,
        "reconcile",
        Some(reason),
        false,
        now,
    )
    .unwrap();
    tx.commit().unwrap();
}

pub(super) fn retire_producer(store: &Store, fixture: &Fixture) {
    store
        .0
        .execute(
            "UPDATE harness_job_attempts SET dispatch_token=NULL WHERE id=?1",
            [&fixture.source],
        )
        .unwrap();
}

pub(super) fn without_native(store: &Store, fixture: &Fixture) {
    store
        .0
        .execute(
            "DELETE FROM workflow_launches WHERE attempt_id=?1",
            [&fixture.native],
        )
        .unwrap();
    store
        .0
        .execute(
            "DELETE FROM workflow_attempts WHERE id=?1",
            [&fixture.native],
        )
        .unwrap();
    store
        .0
        .execute(
            "DELETE FROM operation_receipts WHERE id=?1",
            [&fixture.receipt],
        )
        .unwrap();
}

pub(super) fn native_state(
    store: &Store,
    fixture: &Fixture,
    state: &str,
    phase: &str,
    result: Value,
) {
    store
        .0
        .execute(
            "UPDATE workflow_attempts SET state=?2 WHERE id=?1",
            params![fixture.native, state],
        )
        .unwrap();
    store
        .0
        .execute(
            "UPDATE operation_receipts SET phase=?2,result=?3 WHERE id=?1",
            params![fixture.receipt, phase, result.to_string()],
        )
        .unwrap();
}

fn reserve_late(store: &Store, prefix: &str) {
    let attempt = format!("{prefix}-late-native");
    let receipt = format!("{prefix}-late-receipt");
    let session = format!("{prefix}-late-session");
    let key = format!("run-launch:{attempt}");
    store.0.execute("INSERT INTO operation_receipts(id,issuer,key,digest,operation,phase,session_id,result) VALUES(?1,'owner',?2,'late-digest','create','accepted',?3,'{}')",params![receipt,key,session]).unwrap();
    store.0.execute("INSERT INTO workflow_attempts(id,task_id,ordinal,session_id,state) VALUES(?1,?2,1,?3,'launching')",params![attempt,format!("{prefix}-task"),session]).unwrap();
    store.0.execute("INSERT INTO workflow_launches(attempt_id,operation_id,operation_key,workspace,created_at) VALUES(?1,?2,?3,'shared',?4)",params![attempt,receipt,key,sql_time(NOW+8)]).unwrap();
}

fn executor(store: &Store, fixture: &Fixture) {
    store.0.execute("INSERT INTO workflow_executors(id,run_id,spec,issuer,enabled,generation,phase,created_at) VALUES(?1,?2,'{\"tasks\":[]}','owner',1,1,'enabled',0)",params![format!("{}-pump",fixture.run),fixture.run]).unwrap();
}

fn executor_phase(store: &Store, fixture: &Fixture) -> (bool, String, Option<String>) {
    store
        .0
        .query_row(
            "SELECT enabled,phase,reason FROM workflow_executors WHERE run_id=?1",
            [&fixture.run],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
}

pub(super) fn classification(store: &Store, fixture: &Fixture) -> Value {
    generation(&store.0, fixture)["jobAttempt"]["retryClassification"].clone()
}

#[test]
fn uncertain_absent_launch_is_fenced_probed_and_retried_once_after_its_backoff() {
    let mut store = store();
    let fixture = seed(&store, "absent", Some(retry(3)), 1);
    without_native(&store, &fixture);
    executor(&store, &fixture);
    fail(&mut store, &fixture, "dispatch_unconfirmed", NOW + 5);
    let current = occurrence(&store.0, &fixture);
    assert_eq!(current["state"], "retryWaiting");
    assert_eq!(current["reason"], "retry_probe_pending");
    assert!(current["retry"].is_null());
    let pending = classification(&store, &fixture);
    assert_eq!(pending["class"], "uncertainEffect");
    assert_eq!(pending["decision"], "probing");
    assert_eq!(pending["failure"], "dispatch_unconfirmed");
    assert!(pending["probe"].is_null() && pending["decidedAt"].is_null());
    job_attempts::guard_run(&store.0, &fixture.run).unwrap();
    assert!(claim(&mut store, &fixture, NOW + 6).is_none());
    assert_eq!(classification(&store, &fixture)["decision"], "probing");
    assert_eq!(executor_phase(&store, &fixture).1, "enabled");
    retire_producer(&store, &fixture);
    assert!(claim(&mut store, &fixture, NOW + 7).is_none());
    let decision = job_retries::view(&store.0, &fixture.source).unwrap();
    assert_eq!(decision["class"], "uncertainEffect");
    assert_eq!(decision["attemptId"], Value::Null);
    assert_eq!(decision["decidedAt"], NOW + 7);
    assert_eq!(decision["notBefore"], NOW + 1007);
    assert_eq!(decision["nextOrdinal"], 2);
    assert_eq!(decision["probe"]["result"], "absent");
    assert_eq!(decision["probe"]["observedAt"], NOW + 7);
    assert_eq!(decision["probe"]["runId"], fixture.run);
    assert_eq!(decision["probe"]["executorAccepted"], false);
    assert_eq!(
        decision["probe"]["launchKey"],
        format!("job:{}:{}:executor", fixture.job, fixture.occurrence)
    );
    assert_eq!(
        executor_phase(&store, &fixture),
        (false, "paused".into(), Some("job_retry_waiting".into()))
    );
    assert!(job_attempts::guard_run(&store.0, &fixture.run).is_err());
    let record = generation(&store.0, &fixture);
    assert_eq!(record["jobAttempt"]["state"], "failed");
    assert_eq!(record["jobAttempt"]["reason"], "launch_no_effect");
    assert_eq!(occurrence(&store.0, &fixture)["reason"], "retry_backoff");
    assert!(claim(&mut store, &fixture, NOW + 1006).is_none());
    let (dispatch, ordinal) = claim(&mut store, &fixture, NOW + 1007).unwrap();
    assert_eq!(ordinal, 2);
    assert_eq!(
        job_retries::view(&store.0, &fixture.source).unwrap(),
        decision
    );
    assert_eq!(generation(&store.0, &fixture), record);
    let admitted = &job_attempts::view(
        &store.0,
        &fixture.job,
        &fixture.occurrence,
        Some(&dispatch.attempt),
        0,
    )
    .unwrap()["jobAttempt"]["retryAdmission"];
    assert_eq!(admitted["sourceJobAttemptId"], fixture.source);
    assert_eq!(admitted["class"], "uncertainEffect");
    assert_eq!(admitted["claimProbe"]["result"], "absent");
    assert_eq!(admitted["claimProbe"]["observedAt"], NOW + 1007);
    let diagnostic = job_retries::diagnostic(&store.0, &fixture.source).unwrap();
    assert_eq!(diagnostic["state"], "claimed");
    assert_eq!(diagnostic["retryJobAttemptId"], dispatch.attempt);
    assert_eq!(count(&store.0, "harness_job_attempts"), 2);
    assert!(claim(&mut store, &fixture, NOW + 5000).is_none());
}

#[test]
fn uncertain_probe_adopts_an_in_flight_attempt_and_keeps_overlap_closed() {
    let mut store = store();
    let fixture = seed(&store, "adopt", Some(retry(3)), 1);
    native_state(&store, &fixture, "launching", "dispatching", json!({}));
    let spec: String = store
        .0
        .query_row(
            "SELECT spec FROM harness_job_occurrences WHERE id=?1",
            [&fixture.occurrence],
            |r| r.get(0),
        )
        .unwrap();
    store.0.execute("INSERT INTO harness_job_occurrences(id,job_id,job_revision,spec,trigger_key,trigger_kind,due_at,created_at,state) VALUES('adopt-sibling',?1,1,?2,'adopt-sibling','manual',?3,?3,'queued')",params![fixture.job,spec,sql_time(NOW+4)]).unwrap();
    fail(&mut store, &fixture, "dispatch_unconfirmed", NOW + 5);
    retire_producer(&store, &fixture);
    assert!(claim(&mut store, &fixture, NOW + 6).is_none());
    let current = occurrence(&store.0, &fixture);
    assert_eq!(current["state"], "running");
    assert!(current["reason"].is_null());
    assert!(current["retry"].is_null());
    let adopted = classification(&store, &fixture);
    assert_eq!(adopted["class"], "definiteEffect");
    assert_eq!(adopted["decision"], "adopted");
    assert_eq!(adopted["probe"]["result"], "attemptFound");
    assert_eq!(adopted["probe"]["attemptId"], fixture.native);
    assert_eq!(adopted["probe"]["attemptState"], "launching");
    assert_eq!(adopted["probe"]["launchReceiptId"], fixture.receipt);
    assert_eq!(
        generation(&store.0, &fixture)["jobAttempt"]["state"],
        "running"
    );
    job_attempts::guard_run(&store.0, &fixture.run).unwrap();
    assert!(poll(&mut store, NOW + 5000).is_empty());
    let sibling: String = store
        .0
        .query_row(
            "SELECT state FROM harness_job_occurrences WHERE id='adopt-sibling'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(sibling, "queued");
    assert!(claim(&mut store, &fixture, NOW + 5001).is_none());
    assert_eq!(count(&store.0, "harness_job_attempts"), 1);
    assert_eq!(classification(&store, &fixture), adopted);
}

#[test]
fn unknown_launch_with_session_evidence_is_definite_and_returns_to_reconciliation() {
    let mut store = store();
    let fixture = seed(&store, "session", Some(retry(3)), 1);
    native_state(
        &store,
        &fixture,
        "launchUnknown",
        "unknown",
        json!({"code":"launch_unconfirmed"}),
    );
    store.0.execute("INSERT INTO domain_events(session_id,kind,at,payload) VALUES(?1,'session.created',?2,'{}')",params![fixture.session,sql_time(NOW+4)]).unwrap();
    retire_producer(&store, &fixture);
    fail(&mut store, &fixture, "launch_unconfirmed", NOW + 5);
    assert_eq!(occurrence(&store.0, &fixture)["state"], "retryWaiting");
    assert!(claim(&mut store, &fixture, NOW + 6).is_none());
    let current = occurrence(&store.0, &fixture);
    assert_eq!(current["state"], "reconcile");
    assert_eq!(current["reason"], "launch_unconfirmed");
    let adopted = classification(&store, &fixture);
    assert_eq!(adopted["class"], "definiteEffect");
    assert_eq!(adopted["probe"]["result"], "sessionFound");
    assert_eq!(adopted["probe"]["sessionId"], fixture.session);
    fail(&mut store, &fixture, "dispatch_interrupted", NOW + 7);
    assert_eq!(classification(&store, &fixture), adopted);
    assert_eq!(count(&store.0, "harness_job_retries"), 1);
}

#[test]
fn host_restart_after_a_created_session_is_definite_and_never_retried() {
    let mut store = store();
    let fixture = seed(&store, "restart", Some(retry(3)), 1);
    native_state(
        &store,
        &fixture,
        "assigned",
        "created",
        json!({"sessionId":"restart-session","taskResult":null}),
    );
    retire_producer(&store, &fixture);
    fail(&mut store, &fixture, "host_restarted", NOW + 5);
    assert!(claim(&mut store, &fixture, NOW + 6).is_none());
    let current = occurrence(&store.0, &fixture);
    assert_eq!(current["state"], "reconcile");
    assert_eq!(current["reason"], "host_restarted");
    assert_eq!(
        classification(&store, &fixture)["probe"]["result"],
        "sessionFound"
    );
    assert!(
        job_retries::view(&store.0, &fixture.source)
            .unwrap()
            .is_null()
    );
    assert!(claim(&mut store, &fixture, NOW + 5000).is_none());
    assert_eq!(count(&store.0, "harness_job_attempts"), 1);
}

#[test]
fn uncertain_absence_at_the_generation_limit_fails_terminally_and_keeps_the_fence() {
    let mut store = store();
    let fixture = seed(&store, "limit", Some(retry(1)), 1);
    without_native(&store, &fixture);
    retire_producer(&store, &fixture);
    fail(&mut store, &fixture, "dispatch_interrupted", NOW + 5);
    assert!(claim(&mut store, &fixture, NOW + 6).is_none());
    let current = occurrence(&store.0, &fixture);
    assert_eq!(current["state"], "failed");
    assert_eq!(current["reason"], "retry_exhausted");
    assert_eq!(current["finishedAt"], NOW + 6);
    let decision = job_retries::view(&store.0, &fixture.source).unwrap();
    assert_eq!(decision["probe"]["result"], "absent");
    assert!(decision["nextOrdinal"].is_null());
    assert_eq!(classification(&store, &fixture)["decision"], "blocked");
    assert!(job_attempts::guard_run(&store.0, &fixture.run).is_err());
    assert!(poll(&mut store, NOW + 5000).is_empty());
    assert_eq!(count(&store.0, "harness_job_attempts"), 1);
}

#[test]
fn a_reservation_after_the_probe_blocks_the_due_claim_instead_of_retrying() {
    let mut store = store();
    let fixture = seed(&store, "breach", Some(retry(3)), 1);
    without_native(&store, &fixture);
    retire_producer(&store, &fixture);
    fail(&mut store, &fixture, "dispatch_unconfirmed", NOW + 5);
    assert!(claim(&mut store, &fixture, NOW + 6).is_none());
    let decision = job_retries::view(&store.0, &fixture.source).unwrap();
    let record = generation(&store.0, &fixture);
    reserve_late(&store, "breach");
    assert!(claim(&mut store, &fixture, NOW + 1006).is_none());
    let current = occurrence(&store.0, &fixture);
    assert_eq!(current["state"], "reconcile");
    assert_eq!(current["reason"], "retry_evidence_changed");
    assert_eq!(
        job_retries::view(&store.0, &fixture.source).unwrap(),
        decision
    );
    let after = generation(&store.0, &fixture);
    assert_eq!(
        after["jobAttempt"]["retryClassification"],
        record["jobAttempt"]["retryClassification"]
    );
    assert_eq!(after["jobAttempt"]["state"], "failed");
    assert_eq!(
        after["jobAttempt"]["launchReconciliation"]["retryClassification"]["state"],
        "blocked"
    );
    let diagnostic = job_retries::diagnostic(&store.0, &fixture.source).unwrap();
    assert_eq!(diagnostic["state"], "blocked");
    assert_eq!(diagnostic["claimProbe"]["result"], "attemptFound");
    assert_eq!(diagnostic["claimProbe"]["attemptId"], "breach-late-native");
    assert_eq!(count(&store.0, "harness_job_attempts"), 1);
}

#[test]
fn journal_probe_runs_with_a_full_scheduler_and_a_quota_hold() {
    let mut store = store();
    let fixture = seed(&store, "full", Some(retry(3)), 1);
    without_native(&store, &fixture);
    retire_producer(&store, &fixture);
    fail(&mut store, &fixture, "dispatch_unconfirmed", NOW + 5);
    store
        .0
        .execute(
            "INSERT INTO harness_job_quota_sources(source_id,revision,expires_elapsed_ms,eligible,reason) VALUES('gate_claude',1,?1,0,'fixture_hold')",
            [i64::MAX / 2],
        )
        .unwrap();
    assert_eq!(classification(&store, &fixture)["decision"], "probing");
    match job_definitions::work(&mut store.0, Work::Poll { slots: 0 }, NOW + 6).unwrap() {
        Reply::Claims(claims) => assert!(claims.is_empty()),
        _ => panic!("Expected scheduler claims"),
    }
    let decision = job_retries::view(&store.0, &fixture.source).unwrap();
    assert_eq!(decision["probe"]["result"], "absent");
    assert_eq!(decision["decidedAt"], NOW + 6);
    assert!(job_attempts::guard_run(&store.0, &fixture.run).is_err());
    assert_eq!(count(&store.0, "harness_job_attempts"), 1);
}

#[test]
fn uncertain_classification_publishes_the_stored_retry_waiting_phase() {
    let mut store = store();
    let fixture = seed(&store, "publish", Some(retry(3)), 1);
    without_native(&store, &fixture);
    fail(&mut store, &fixture, "dispatch_unconfirmed", NOW + 5);
    let phases: Vec<String> = store
        .0
        .prepare("SELECT json_extract(payload,'$.phase') FROM domain_events WHERE kind='job.changed' ORDER BY sequence")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(phases, ["retryWaiting"]);
}

#[test]
fn uncertain_failure_without_a_policy_keeps_the_existing_reconcile() {
    let mut store = store();
    let fixture = seed(&store, "unopted", None, 1);
    without_native(&store, &fixture);
    retire_producer(&store, &fixture);
    fail(&mut store, &fixture, "dispatch_unconfirmed", NOW + 5);
    let current = occurrence(&store.0, &fixture);
    assert_eq!(current["state"], "reconcile");
    assert_eq!(current["reason"], "dispatch_unconfirmed");
    assert_eq!(count(&store.0, "harness_job_retries"), 0);
    assert!(classification(&store, &fixture).is_null());
    assert!(claim(&mut store, &fixture, NOW + 5000).is_none());
}

#[test]
fn proven_refusal_reached_through_an_uncertain_reply_takes_the_no_effect_class() {
    let mut store = store();
    let fixture = seed(&store, "proven", Some(retry(3)), 1);
    retire_producer(&store, &fixture);
    fail(&mut store, &fixture, "dispatch_unconfirmed", NOW + 5);
    assert!(consider(&mut store, &fixture, NOW + 6));
    assert_eq!(classification(&store, &fixture)["decision"], "probing");
    assert!(claim(&mut store, &fixture, NOW + 7).is_none());
    let decision = job_retries::view(&store.0, &fixture.source).unwrap();
    assert_eq!(decision["class"], "noEffect");
    assert_eq!(decision["attemptId"], fixture.native);
    assert_eq!(decision["launchReceiptId"], fixture.receipt);
    assert_eq!(decision["notBefore"], NOW + 1007);
    assert!(decision.get("probe").is_none());
    assert_eq!(
        classification(&store, &fixture)["probe"]["result"],
        "noEffectProven"
    );
    assert_eq!(claim(&mut store, &fixture, NOW + 1007).unwrap().1, 2);
}

#[test]
fn adopted_attempt_that_later_proves_no_effect_is_never_retried() {
    let mut store = store();
    let fixture = seed(&store, "convert", Some(retry(3)), 1);
    native_state(&store, &fixture, "launching", "dispatching", json!({}));
    retire_producer(&store, &fixture);
    fail(&mut store, &fixture, "dispatch_unconfirmed", NOW + 5);
    assert!(claim(&mut store, &fixture, NOW + 6).is_none());
    let adopted = classification(&store, &fixture);
    assert_eq!(adopted["decision"], "adopted");
    native_state(
        &store,
        &fixture,
        "launchFailed",
        "failed",
        json!({"code":"invalid_launch","message":"Recorded pre-native validation refusal","effectStarted":false}),
    );
    assert!(!consider(&mut store, &fixture, NOW + 10));
    assert!(
        job_retries::view(&store.0, &fixture.source)
            .unwrap()
            .is_null()
    );
    assert_eq!(classification(&store, &fixture), adopted);
    assert_ne!(occurrence(&store.0, &fixture)["state"], "retryWaiting");
    assert!(claim(&mut store, &fixture, NOW + 5000).is_none());
    assert_eq!(count(&store.0, "harness_job_attempts"), 1);
}

#[test]
fn owner_cancels_probing_and_fenced_uncertain_decisions_without_native_stop() {
    let mut store = store();
    let probing = seed(&store, "cancel-probing", Some(retry(3)), 1);
    without_native(&store, &probing);
    retire_producer(&store, &probing);
    fail(&mut store, &probing, "dispatch_unconfirmed", NOW + 5);
    let tx = store.0.transaction().unwrap();
    let canceled =
        job_cancellations::accept(&tx, &owner(), &probing.job, &probing.occurrence, NOW + 6)
            .unwrap();
    tx.commit().unwrap();
    assert_eq!(canceled["occurrence"]["state"], "canceling");
    assert_eq!(classification(&store, &probing)["decision"], "canceled");
    assert!(claim(&mut store, &probing, NOW + 5000).is_none());

    let fenced = seed(&store, "cancel-fenced", Some(retry(3)), 1);
    without_native(&store, &fenced);
    retire_producer(&store, &fenced);
    fail(&mut store, &fenced, "dispatch_unconfirmed", NOW + 5);
    assert!(claim(&mut store, &fenced, NOW + 6).is_none());
    let record = generation(&store.0, &fenced);
    let tx = store.0.transaction().unwrap();
    let canceled =
        job_cancellations::accept(&tx, &owner(), &fenced.job, &fenced.occurrence, NOW + 7).unwrap();
    tx.commit().unwrap();
    assert_eq!(canceled["occurrence"]["state"], "canceled");
    assert_eq!(generation(&store.0, &fenced), record);
    let diagnostic = job_retries::diagnostic(&store.0, &fenced.source).unwrap();
    assert_eq!(diagnostic["state"], "canceled");
    assert_eq!(diagnostic["claimProbe"]["result"], "absent");
    assert_eq!(count(&store.0, "workflow_controls"), 0);
    assert!(claim(&mut store, &fenced, NOW + 5000).is_none());
}
