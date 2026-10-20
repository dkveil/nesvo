use super::Store;
use crate::{
    job_definitions::{self, Reply, Work},
    job_prechecks::{self, Outcome, OutcomeState},
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
fn command() -> Value {
    json!({"title":"Bounded check","executable":if cfg!(windows){"C:/tools/check.exe"}else{"/usr/bin/check"},"arguments":["literal $(x); & łódź"],"cwd":if cfg!(windows){"C:/workspace"}else{"/workspace"}})
}
fn request(store: &mut Store, value: Value) -> anyhow::Result<Value> {
    job_prechecks::execute(
        &mut store.0,
        owner(),
        serde_json::from_value(value).unwrap(),
        NOW,
    )
}
fn describe(store: &mut Store, spec: &Value) -> Value {
    request(store, json!({"action":"describe","spec":spec})).unwrap()["precheckDescription"].clone()
}
fn approve(store: &mut Store, key: &str) -> Value {
    let spec = command();
    let digest = describe(store, &spec)["digest"].clone();
    request(
        store,
        json!({"action":"approve","key":key,"spec":spec,"expectedDigest":digest}),
    )
    .unwrap()["precheckApproval"]
        .clone()
}
fn job(store: &mut Store, approval: &Value, key: &str) -> Value {
    job_definitions::execute(&mut store.0,owner(),serde_json::from_value(json!({"action":"create","key":key,"spec":{"title":"Checked job","instruction":"Report result","profile":{"program":"claude","workspace":"shared"},"precheckId":approval["id"],"schedule":{"kind":"once","at":chrono::DateTime::from_timestamp_millis((NOW+1000)as i64).unwrap().to_rfc3339()}}})).unwrap(),NOW).unwrap()["job"].clone()
}
fn claim(store: &mut Store, job: &Value) -> (String, crate::job_attempts::Dispatch) {
    let reply = job_definitions::work(&mut store.0, Work::Poll { slots: 4 }, NOW + 1000).unwrap();
    let Reply::Claims(claims) = reply else {
        panic!("claims")
    };
    let claim = claims.into_iter().find(|c| c.job_id == job["id"]).unwrap();
    (claim.id, claim.dispatch)
}
fn occurrence(store: &mut Store, job: &Value, id: &str) -> Value {
    job_definitions::execute(
        &mut store.0,
        owner(),
        serde_json::from_value(json!({"action":"occurrence","jobId":job["id"],"occurrenceId":id}))
            .unwrap(),
        NOW + 2000,
    )
    .unwrap()["occurrence"]
        .clone()
}
fn outcome(state: OutcomeState) -> Outcome {
    Outcome {
        state,
        reason: "controlled".into(),
        exit_code: Some(10),
        stdout: "No changes\n".into(),
        stderr: "".into(),
        stdout_truncated: false,
        stderr_truncated: false,
        duration_ms: 25,
        cleanup_confirmed: true,
        command_started: Some(true),
    }
}
#[test]
fn approval_is_separate_explicit_immutable_and_revocation_does_not_reapprove_on_replay() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let spec = command();
    let preview = describe(&mut store, &spec);
    assert_eq!(preview["trust"], "notApproved");
    assert_eq!(preview["spec"]["version"], 1);
    assert_eq!(preview["spec"]["timeoutMs"], 2000);
    assert_eq!(
        store
            .0
            .query_row("SELECT count(*) FROM harness_precheck_approvals", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(
        request(
            &mut store,
            json!({"action":"approve","key":"wrong","spec":spec,"expectedDigest":"wrong"})
        )
        .is_err()
    );
    let original =
        json!({"action":"approve","key":"once","spec":spec,"expectedDigest":preview["digest"]});
    let accepted = request(&mut store, original.clone()).unwrap();
    let id = accepted["precheckApproval"]["id"].clone();
    let revoked = request(
        &mut store,
        json!({"action":"revoke","key":"revoke","id":id,"expectedRevision":1}),
    )
    .unwrap();
    assert_eq!(revoked["precheckApproval"]["enabled"], false);
    assert_eq!(request(&mut store, original.clone()).unwrap(), accepted);
    let current = request(&mut store, json!({"action":"get","id":id})).unwrap();
    assert_eq!(current, revoked);
    let mut changed = original;
    changed["spec"]["arguments"] = json!(["different"]);
    assert!(
        request(&mut store, changed)
            .err()
            .unwrap()
            .downcast_ref::<crate::api_error::Error>()
            .is_some_and(|e| e.code == "idempotency_conflict")
    );
    let mut q = store
        .0
        .prepare("SELECT kind,payload FROM domain_events WHERE kind='precheck.approval.changed'")
        .unwrap();
    let events = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(events.len(), 2);
    assert!(events.iter().all(|(_, body)| !body.contains("literal")));
}
#[test]
fn every_registry_action_is_owner_only_and_invalid_commands_leave_no_approval() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    for scope in [Scope::Coordinator("c".into()), Scope::Worker("w".into())] {
        for action in [
            json!({"action":"describe","spec":command()}),
            json!({"action":"list"}),
            json!({"action":"approve","key":"k","spec":command(),"expectedDigest":"x"}),
            json!({"action":"get","id":"missing"}),
            json!({"action":"revoke","key":"k","id":"missing","expectedRevision":1}),
            json!({"action":"mutation","key":"missing"}),
        ] {
            let error = job_prechecks::execute(
                &mut store.0,
                Actor {
                    issuer: "scoped".into(),
                    scope: scope.clone(),
                },
                serde_json::from_value(action).unwrap(),
                NOW,
            )
            .err()
            .unwrap();
            assert_eq!(
                error
                    .downcast_ref::<crate::api_error::Error>()
                    .unwrap()
                    .code,
                "forbidden"
            );
        }
    }
    for extra in [
        json!({"executable":"relative"}),
        json!({"cwd":"relative"}),
        json!({"timeoutMs":10001}),
        json!({"passExitCodes":[0],"skipExitCodes":[0]}),
        json!({"passExitCodes":[]}),
        json!({"environment":{"NESVO_CLIENT_SESSION_ID":"forged"}}),
        json!({"environment":{"pocket_host_key":"forged"}}),
        json!({"version":2}),
        json!({"environment":{"SystemRoot":"custom"}}),
        json!({"environment":{"PATH":"one","Path":"two"}}),
    ] {
        let mut spec = command();
        spec.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(request(&mut store, json!({"action":"describe","spec":spec})).is_err());
    }
    assert!(
        serde_json::from_value::<job_prechecks::Command>(
            json!({"title":"x","executable":"x","cwd":"x","trusted":true})
        )
        .is_err()
    );
}
#[test]
fn skipped_or_failed_precheck_never_has_a_run_and_cannot_be_reexecuted() {
    for state in [
        OutcomeState::Skipped,
        OutcomeState::Failed,
        OutcomeState::TimedOut,
        OutcomeState::OutputLimit,
        OutcomeState::Refused,
    ] {
        let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let approval = approve(&mut store, "check");
        let job = job(&mut store, &approval, "job");
        let (id, dispatch) = claim(&mut store, &job);
        assert!(
            job_definitions::work(
                &mut store.0,
                Work::BindRun {
                    dispatch: dispatch.clone(),
                    run: "not-started".into()
                },
                NOW + 1000
            )
            .err()
            .unwrap()
            .downcast_ref::<crate::api_error::Error>()
            .is_some_and(|e| e.code == "precheck_required")
        );
        assert!(matches!(
            job_definitions::work(
                &mut store.0,
                Work::BeginPrecheck {
                    dispatch: dispatch.clone()
                },
                NOW + 1000
            )
            .unwrap(),
            Reply::Precheck(Some(_))
        ));
        assert!(
            job_definitions::work(
                &mut store.0,
                Work::BeginPrecheck {
                    dispatch: dispatch.clone()
                },
                NOW + 1001
            )
            .is_err()
        );
        let reply = job_definitions::work(
            &mut store.0,
            Work::FinishPrecheck {
                dispatch: dispatch.clone(),
                result: outcome(state),
            },
            NOW + 1025,
        )
        .unwrap();
        assert!(matches!(reply, Reply::PrecheckPassed(false)));
        let current = occurrence(&mut store, &job, &id);
        assert!(current["runId"].is_null());
        assert!(current["finishedAt"].is_number());
        assert!(matches!(
            current["state"].as_str(),
            Some("failed" | "skipped")
        ));
        assert!(
            job_definitions::work(
                &mut store.0,
                Work::FinishPrecheck {
                    dispatch: dispatch.clone(),
                    result: outcome(OutcomeState::Passed)
                },
                NOW + 1026
            )
            .is_err()
        );
        assert_eq!(
            store
                .0
                .query_row("SELECT count(*) FROM workflow_runs", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
#[test]
fn revoked_approval_refuses_queued_use_but_authorized_checks_keep_their_snapshot() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let approval = approve(&mut store, "check");
    let a = job(&mut store, &approval, "a");
    let b = job(&mut store, &approval, "b");
    let Reply::Claims(claims) =
        job_definitions::work(&mut store.0, Work::Poll { slots: 4 }, NOW + 1000).unwrap()
    else {
        panic!("claims")
    };
    let a_id = claims
        .iter()
        .find(|c| c.job_id == a["id"])
        .unwrap()
        .id
        .clone();
    let b_id = claims
        .iter()
        .find(|c| c.job_id == b["id"])
        .unwrap()
        .id
        .clone();
    let a_dispatch = claims
        .iter()
        .find(|c| c.id == a_id)
        .unwrap()
        .dispatch
        .clone();
    let b_dispatch = claims
        .iter()
        .find(|c| c.id == b_id)
        .unwrap()
        .dispatch
        .clone();
    assert!(matches!(
        job_definitions::work(
            &mut store.0,
            Work::BeginPrecheck {
                dispatch: a_dispatch.clone()
            },
            NOW + 1000
        )
        .unwrap(),
        Reply::Precheck(Some(_))
    ));
    request(
        &mut store,
        json!({"action":"revoke","key":"off","id":approval["id"],"expectedRevision":1}),
    )
    .unwrap();
    assert!(matches!(
        job_definitions::work(
            &mut store.0,
            Work::BeginPrecheck {
                dispatch: b_dispatch.clone()
            },
            NOW + 1001
        )
        .unwrap(),
        Reply::PrecheckPassed(false)
    ));
    assert_eq!(
        occurrence(&mut store, &b, &b_id)["reason"],
        "precheck_not_trusted"
    );
    assert!(matches!(
        job_definitions::work(
            &mut store.0,
            Work::FinishPrecheck {
                dispatch: a_dispatch.clone(),
                result: outcome(OutcomeState::Passed)
            },
            NOW + 1002
        )
        .unwrap(),
        Reply::PrecheckPassed(true)
    ));
    let current = occurrence(&mut store, &a, &a_id);
    assert_eq!(current["state"], "dispatching");
    assert_eq!(current["precheck"]["approvalDigest"], approval["digest"]);
}
#[test]
fn unconfirmed_cleanup_or_restart_requires_explicit_abandonment_never_resume() {
    for restart in [false, true] {
        let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let approval = approve(&mut store, "check");
        let job = job(&mut store, &approval, "job");
        let (id, dispatch) = claim(&mut store, &job);
        job_definitions::work(
            &mut store.0,
            Work::BeginPrecheck {
                dispatch: dispatch.clone(),
            },
            NOW + 1000,
        )
        .unwrap();
        if restart {
            job_definitions::recover(&mut store.0, NOW + 1001).unwrap();
        } else {
            let mut result = outcome(OutcomeState::Passed);
            result.cleanup_confirmed = false;
            job_definitions::work(
                &mut store.0,
                Work::FinishPrecheck {
                    dispatch: dispatch.clone(),
                    result,
                },
                NOW + 1001,
            )
            .unwrap();
        }
        let current = occurrence(&mut store, &job, &id);
        assert_eq!(current["state"], "reconcile");
        assert_eq!(current["precheck"]["state"], "unknown");
        assert!(current["precheck"]["finishedAt"].is_null());
        assert!(current["runId"].is_null());
        assert!(
            job_definitions::work(
                &mut store.0,
                Work::BeginPrecheck {
                    dispatch: dispatch.clone()
                },
                NOW + 1002
            )
            .is_err()
        );
        let abandon = json!({"action":"abandonPrecheck","key":"abandon","jobId":job["id"],"occurrenceId":id,"expectedDigest":approval["digest"],"acknowledgeUnknownEffects":true});
        let mut wrong = abandon.clone();
        wrong["acknowledgeUnknownEffects"] = false.into();
        assert!(
            job_definitions::execute(
                &mut store.0,
                owner(),
                serde_json::from_value(wrong).unwrap(),
                NOW + 1002
            )
            .is_err()
        );
        let accepted = job_definitions::execute(
            &mut store.0,
            owner(),
            serde_json::from_value(abandon.clone()).unwrap(),
            NOW + 1002,
        )
        .unwrap();
        assert_eq!(accepted["occurrence"]["state"], "canceled");
        assert!(accepted["occurrence"]["precheck"]["finishedAt"].is_null());
        assert_eq!(
            accepted,
            job_definitions::execute(
                &mut store.0,
                owner(),
                serde_json::from_value(abandon).unwrap(),
                NOW + 1003
            )
            .unwrap()
        );
    }
}
#[test]
fn no_dispatch_slots_still_materializes_due_intent_and_unchecked_jobs_keep_old_fingerprint() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let approval = approve(&mut store, "check");
    let job = job(&mut store, &approval, "job");
    let Reply::Claims(claims) =
        job_definitions::work(&mut store.0, Work::Poll { slots: 0 }, NOW + 1000).unwrap()
    else {
        panic!("claims")
    };
    assert!(claims.is_empty());
    let (id, _) = claim(&mut store, &job);
    assert!(occurrence(&mut store, &job, &id)["precheck"].is_null());
    let spec:job_definitions::Spec=serde_json::from_value(json!({"title":"Legacy job","instruction":"x","profile":{"program":"claude","workspace":"shared"},"schedule":{"kind":"once","at":"2026-12-01T00:00:00Z"}})).unwrap();
    assert!(
        !serde_json::to_value(spec)
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("precheckId")
    );
}

#[test]
fn passed_metadata_without_observed_command_start_cannot_permit_model_dispatch() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let approval = approve(&mut store, "check");
    let job = job(&mut store, &approval, "job");
    let (id, dispatch) = claim(&mut store, &job);
    job_definitions::work(
        &mut store.0,
        Work::BeginPrecheck {
            dispatch: dispatch.clone(),
        },
        NOW + 1000,
    )
    .unwrap();
    let mut result = outcome(OutcomeState::Passed);
    result.command_started = None;
    assert!(matches!(
        job_definitions::work(
            &mut store.0,
            Work::FinishPrecheck {
                dispatch: dispatch.clone(),
                result
            },
            NOW + 1001
        )
        .unwrap(),
        Reply::PrecheckPassed(false)
    ));
    let view = occurrence(&mut store, &job, &id);
    assert_eq!(view["state"], "reconcile");
    assert_eq!(view["precheck"]["reason"], "execution_unconfirmed");
    assert!(view["runId"].is_null());
}
