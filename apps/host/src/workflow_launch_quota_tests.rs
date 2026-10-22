use super::Store;
use crate::{
    job_definitions::{self, Work as JobWork},
    job_quota::{Binding, Observation},
    orchestration::{self, Actor, Scope},
    workflow_launches::{self, Dispatch, Reply, Request, Work},
};
use serde_json::{Value, json};

const NOW: u64 = 1_792_416_000_000;

fn owner() -> Actor {
    Actor {
        issuer: "owner".into(),
        scope: Scope::Owner,
    }
}

fn publish(store: &mut Store, revision: u64, eligible: bool) {
    let elapsed = crate::event_log::monotonic_millis();
    job_definitions::work_at(
        &mut store.0,
        JobWork::QuotaObserved {
            observation: Observation {
                source_id: "native-quota-fixture".into(),
                revision,
                binding: Some(Binding {
                    context_id: "a".repeat(64),
                    account_fingerprint: "b".repeat(64),
                }),
                expires_elapsed_ms: elapsed + 60_000,
                eligible,
                reason: if eligible {
                    "observed"
                } else {
                    "backend_denied"
                }
                .into(),
            },
        },
        NOW,
        elapsed,
    )
    .unwrap();
}

fn job_request(store: &mut Store, request: Value) -> Value {
    job_definitions::execute_at(
        &mut store.0,
        owner(),
        serde_json::from_value(request).unwrap(),
        NOW,
        crate::event_log::monotonic_millis(),
    )
    .unwrap()
}

fn metadata(store: &mut Store, dispatch: &crate::job_attempts::Dispatch, request: Value) -> Value {
    match job_definitions::work_at(
        &mut store.0,
        JobWork::Prepare {
            dispatch: dispatch.clone(),
            request: serde_json::from_value(request).unwrap(),
        },
        NOW,
        crate::event_log::monotonic_millis(),
    )
    .unwrap()
    {
        job_definitions::Reply::Prepared(view) => view,
        _ => panic!("Expected guarded metadata preparation"),
    }
}

fn active(store: &mut Store) -> (Value, crate::job_definitions::Claim) {
    let definition = job_request(
        store,
        json!({"action":"create","key":"definition","spec":{
            "title":"Retained native workspace","instruction":"Metadata evidence only",
            "profile":{"program":"codex","workspace":"worktree"},
            "schedule":{"kind":"once","at":"2026-12-01T00:00:00Z"},
            "quotaPolicy":{"mode":"wait","contextId":"a".repeat(64),"accountFingerprint":"b".repeat(64)}
        }}),
    );
    job_request(
        store,
        json!({"action":"runNow","key":"once","jobId":definition["job"]["id"],"expectedRevision":1}),
    );
    publish(store, 1, true);
    let job_definitions::Reply::Claims(mut claims) = job_definitions::work_at(
        &mut store.0,
        JobWork::Poll { slots: 1 },
        NOW,
        crate::event_log::monotonic_millis(),
    )
    .unwrap() else {
        panic!("Expected a real metadata claim");
    };
    assert_eq!(claims.len(), 1);
    let claim = claims.pop().unwrap();
    job_definitions::work_at(
        &mut store.0,
        JobWork::BeginPrecheck {
            dispatch: claim.dispatch.clone(),
        },
        NOW,
        crate::event_log::monotonic_millis(),
    )
    .unwrap();
    let created = metadata(
        store,
        &claim.dispatch,
        json!({"action":"create","key":"run","spec":{"title":"Retained launch","goal":"Metadata only"}}),
    );
    let run = created["run"]["id"].clone();
    job_definitions::work_at(
        &mut store.0,
        JobWork::BindRun {
            dispatch: claim.dispatch.clone(),
            run: run.as_str().unwrap().into(),
        },
        NOW,
        crate::event_log::monotonic_millis(),
    )
    .unwrap();
    let plan = metadata(
        store,
        &claim.dispatch,
        json!({"action":"setPlan","key":"plan","runId":run,"expectedRevision":created["run"]["revision"],"tasks":[{"key":"job","title":"One native attempt","instruction":"No native process in this test"}]}),
    );
    let budget = metadata(
        store,
        &claim.dispatch,
        json!({"action":"runBudget","request":{"action":"set","key":"budget","runId":run,"expectedRevision":plan["run"]["revision"],"limits":{"maxParallel":1,"maxAttemptsPerTask":1,"maxElapsedMs":300000}}}),
    );
    let active = metadata(
        store,
        &claim.dispatch,
        json!({"action":"activate","key":"activate","runId":run,"expectedRevision":budget["run"]["revision"]}),
    );
    job_definitions::work_at(
        &mut store.0,
        JobWork::Started {
            dispatch: claim.dispatch.clone(),
        },
        NOW,
        crate::event_log::monotonic_millis(),
    )
    .unwrap();
    (active, claim)
}

fn request(run: &Value) -> Request {
    serde_json::from_value(json!({"key":"one-launch","runId":run["run"]["id"],"taskId":run["tasks"][0]["id"],"expectedRevision":run["run"]["revision"],"profile":{"program":"codex","workspace":"worktree"}})).unwrap()
}

fn prepare(store: &mut Store, request: Request) -> anyhow::Result<(Value, Option<Box<Dispatch>>)> {
    match workflow_launches::execute(
        &mut store.0,
        Work::Prepare {
            actor: owner(),
            request,
        },
        NOW,
    )? {
        Reply::Prepared { view, dispatch } => Ok((view, dispatch)),
        _ => panic!("Expected a launch reservation"),
    }
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

#[test]
fn quota_loss_before_launch_reservation_allocates_no_native_attempt_or_receipt() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (active, job) = active(&mut store);
    let intent = request(&active);
    publish(&mut store, 2, false);
    code(prepare(&mut store, intent.clone()), "quota_wait");
    for table in [
        "workflow_attempts",
        "workflow_launches",
        "operation_receipts",
    ] {
        let count: i64 = store
            .0
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "Waiting allocated {table}");
    }
    publish(&mut store, 3, true);
    let (_, dispatch) = prepare(&mut store, intent).unwrap();
    let dispatch = dispatch.unwrap();
    let permit = dispatch.quota.unwrap();
    assert_eq!(permit.occurrence_id, job.id);
    assert_eq!(permit.job_attempt_id, job.dispatch.attempt);
    assert_eq!(permit.run_id, active["run"]["id"].as_str().unwrap());
    assert_eq!(permit.binding.context_id, "a".repeat(64));
}

#[test]
fn prepared_workspace_and_receipt_remain_exact_during_hold_and_saved_acceptance_replay() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (active, _) = active(&mut store);
    let intent = request(&active);
    let (accepted, dispatch) = prepare(&mut store, intent.clone()).unwrap();
    let dispatch = dispatch.unwrap();
    let claim = crate::receipts::claim(&mut store.0, &dispatch.receipt.id, "owner")
        .unwrap()
        .unwrap();
    let mut prepared = dispatch.spec.clone();
    prepared.cwd = Some(crate::process::display_path(
        &std::env::temp_dir().join("nesvo-owned-prepared-metadata"),
    ));
    prepared.worktree = false;
    code(
        workflow_launches::execute(
            &mut store.0,
            Work::PreparedWorkspace {
                operation_id: claim.receipt.id.clone(),
                token: "forged".into(),
                spec: Box::new(prepared.clone()),
                derived_worktree: true,
            },
            NOW,
        ),
        "launch_claim_conflict",
    );
    workflow_launches::execute(
        &mut store.0,
        Work::PreparedWorkspace {
            operation_id: claim.receipt.id.clone(),
            token: claim.token.clone(),
            spec: Box::new(prepared.clone()),
            derived_worktree: true,
        },
        NOW,
    )
    .unwrap();
    let cursor = store.cursors().unwrap().0;
    workflow_launches::execute(
        &mut store.0,
        Work::PreparedWorkspace {
            operation_id: claim.receipt.id.clone(),
            token: claim.token.clone(),
            spec: Box::new(prepared.clone()),
            derived_worktree: true,
        },
        NOW + 1,
    )
    .unwrap();
    assert_eq!(
        store.cursors().unwrap().0,
        cursor,
        "Exact evidence replay is quiet"
    );
    let mut changed = prepared.clone();
    changed.cwd = Some(crate::process::display_path(
        &std::env::temp_dir().join("never-adopt-another-workspace"),
    ));
    code(
        workflow_launches::execute(
            &mut store.0,
            Work::PreparedWorkspace {
                operation_id: claim.receipt.id.clone(),
                token: claim.token.clone(),
                spec: Box::new(changed),
                derived_worktree: true,
            },
            NOW + 2,
        ),
        "launch_workspace_conflict",
    );
    publish(&mut store, 2, false);
    workflow_launches::execute(
        &mut store.0,
        Work::QuotaHold {
            operation_id: claim.receipt.id.clone(),
            token: claim.token.clone(),
            reason: Some("quota_wait".into()),
        },
        NOW + 3,
    )
    .unwrap();
    let held = workflow_launches::summary(&store.0, &dispatch.attempt_id).unwrap();
    assert_eq!(held["phase"], "dispatching");
    assert_eq!(held["sessionId"], dispatch.receipt.session_id);
    assert_eq!(
        held["preparedWorkspace"]["directory"],
        prepared.cwd.unwrap()
    );
    assert_eq!(held["preparedWorkspace"]["derivedWorktree"], true);
    assert_eq!(held["quotaHoldReason"], "quota_wait");
    assert!(held["effectStarted"].is_null());
    let (replay, redispatch) = prepare(&mut store, intent).unwrap();
    assert_eq!(replay, accepted);
    assert!(
        redispatch.is_none(),
        "A retained claim cannot be redispatched"
    );
    let receipts: i64 = store
        .0
        .query_row("SELECT count(*) FROM operation_receipts", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(receipts, 1);
    let saved: String = store
        .0
        .query_row(
            "SELECT prepared_spec FROM workflow_launches WHERE operation_id=?1",
            [&claim.receipt.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&saved).unwrap()["worktree"],
        false
    );
    assert!(
        serde_json::from_str::<Value>(&saved)
            .unwrap()
            .get("quotaLaunch")
            .is_none()
    );
    let constraints = orchestration::execute_at(
        &mut store.0,
        owner(),
        serde_json::from_value(json!({"action":"constraints","request":{"action":"add","key":"new-constraint","runId":active["run"]["id"],"expectedRevision":accepted["run"]["revision"],"text":"Changed while native workspace preparation was held"}})).unwrap(),
        NOW+4,
    ).unwrap();
    orchestration::execute_at(
        &mut store.0,
        owner(),
        serde_json::from_value(json!({"action":"constraints","request":{"action":"acknowledge","key":"ack-constraint","runId":active["run"]["id"],"expectedRevision":constraints["run"]["revision"],"constraintRevision":1}})).unwrap(),
        NOW+5,
    ).unwrap();
    let prepared: crate::jobs::LaunchSpec = serde_json::from_str(&saved).unwrap();
    workflow_launches::execute(
        &mut store.0,
        Work::PreparedWorkspace {
            operation_id: claim.receipt.id.clone(),
            token: claim.token.clone(),
            spec: Box::new(prepared),
            derived_worktree: true,
        },
        NOW + 6,
    )
    .unwrap();
    code(
        workflow_launches::execute(
            &mut store.0,
            Work::QuotaHold {
                operation_id: claim.receipt.id,
                token: claim.token,
                reason: None,
            },
            NOW + 7,
        ),
        "constraints_changed",
    );
    assert_eq!(
        workflow_launches::summary(&store.0, &dispatch.attempt_id).unwrap(),
        held,
        "ACK permits fresh intent, never the original continuation under an older constraint revision"
    );
}

#[test]
fn restart_keeps_prepared_directory_as_uncertain_evidence_without_a_live_continuation() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let (active, _) = active(&mut store);
    let intent = request(&active);
    let (accepted, dispatch) = prepare(&mut store, intent.clone()).unwrap();
    let dispatch = dispatch.unwrap();
    let claim = crate::receipts::claim(&mut store.0, &dispatch.receipt.id, "owner")
        .unwrap()
        .unwrap();
    let mut prepared = dispatch.spec.clone();
    prepared.cwd = Some(crate::process::display_path(
        &std::env::temp_dir().join("retained-after-restart"),
    ));
    prepared.worktree = false;
    workflow_launches::execute(
        &mut store.0,
        Work::PreparedWorkspace {
            operation_id: claim.receipt.id.clone(),
            token: claim.token.clone(),
            spec: Box::new(prepared.clone()),
            derived_worktree: true,
        },
        NOW,
    )
    .unwrap();
    workflow_launches::execute(
        &mut store.0,
        Work::QuotaHold {
            operation_id: claim.receipt.id.clone(),
            token: claim.token.clone(),
            reason: Some("quota_wait".into()),
        },
        NOW,
    )
    .unwrap();
    crate::receipts::initialize(&mut store.0).unwrap();
    workflow_launches::recover(&mut store.0).unwrap();
    let recovered = workflow_launches::summary(&store.0, &dispatch.attempt_id).unwrap();
    assert_eq!(recovered["phase"], "unknown");
    assert_eq!(
        recovered["preparedWorkspace"]["directory"],
        prepared.cwd.unwrap()
    );
    assert!(recovered["quotaHoldReason"].is_null());
    assert!(recovered["effectStarted"].is_null());
    code(
        workflow_launches::execute(
            &mut store.0,
            Work::QuotaHold {
                operation_id: claim.receipt.id.clone(),
                token: claim.token,
                reason: None,
            },
            NOW + 1,
        ),
        "launch_claim_conflict",
    );
    assert!(
        crate::receipts::claim(&mut store.0, &claim.receipt.id, "owner")
            .unwrap()
            .is_none()
    );
    let (replay, redispatch) = prepare(&mut store, intent).unwrap();
    assert_eq!(replay, accepted);
    assert!(redispatch.is_none());
    let view = orchestration::execute_at(
        &mut store.0,
        owner(),
        serde_json::from_value(json!({"action":"get","runId":active["run"]["id"]})).unwrap(),
        NOW,
    )
    .unwrap();
    assert_eq!(view["tasks"][0]["state"], "launchUnknown");
}
