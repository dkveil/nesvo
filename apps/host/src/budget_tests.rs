use super::{
    Service, Store,
    orchestration_tests::{error, execute},
};
use crate::{
    budgets::{self, Limits, Providers, Usage},
    caller::Role,
    launchers::Program,
    orchestration::{Actor, Request, Scope},
};
use serde_json::{Value, json};

fn limits(slots: u16, workers: u16, shell: u16) -> Value {
    json!({"maxSessions":slots,"maxWorkers":workers,"providers":{"shell":shell,"claude":8,"codex":8,"gemini":8}})
}
fn set(key: &str, revision: u64, limits: Value) -> Value {
    json!({"action":"hostBudget","request":{"action":"set","key":key,"expectedRevision":revision,"limits":limits}})
}
#[test]
fn admission_separates_retained_slots_live_workers_and_provider_processes() {
    budgets::admit_snapshot_bytes(32 * 1024, 1024).unwrap();
    error(
        budgets::admit_snapshot_bytes(48 * 1024, 1),
        "budget_snapshot_capacity",
    );
    error(
        budgets::admit_snapshot_bytes(usize::MAX, usize::MAX),
        "budget_snapshot_capacity",
    );
    let policy = Limits {
        max_sessions: 12,
        max_workers: 2,
        providers: Providers {
            shell: 3,
            claude: 1,
            codex: 0,
            gemini: 4,
        },
    };
    policy.validate().unwrap();
    error(
        policy.admit(
            Usage {
                retained: 12,
                ..Default::default()
            },
            Program::Shell,
            Role::Worker,
        ),
        "budget_exhausted",
    );
    error(
        policy.admit(
            Usage {
                workers: 2,
                ..Default::default()
            },
            Program::Shell,
            Role::Worker,
        ),
        "budget_exhausted",
    );
    policy
        .admit(
            Usage {
                workers: 2,
                ..Default::default()
            },
            Program::Shell,
            Role::Coordinator,
        )
        .unwrap();
    error(
        policy.admit(
            Usage {
                provider: 1,
                ..Default::default()
            },
            Program::Claude,
            Role::Coordinator,
        ),
        "budget_exhausted",
    );
    error(
        policy.admit(Usage::default(), Program::Codex, Role::Worker),
        "budget_exhausted",
    );
    policy
        .admit(
            Usage {
                retained: 11,
                workers: 1,
                provider: 2,
            },
            Program::Shell,
            Role::Worker,
        )
        .unwrap();
}
#[test]
fn owner_revisions_recovery_and_storage_failure_never_restore_or_partially_change_policy() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let first = set("policy-1", 1, limits(12, 2, 1));
    error(
        execute(&mut store, Some("coordinator"), first.clone()),
        "forbidden",
    );
    let saved = execute(&mut store, None, first.clone()).unwrap();
    assert_eq!(saved["budget"]["revision"], 2);
    error(
        execute(&mut store, None, set("stale", 1, limits(10, 1, 1))),
        "revision_conflict",
    );
    for invalid in [
        limits(0, 1, 1),
        limits(17, 1, 1),
        limits(16, 17, 1),
        limits(16, 1, 17),
    ] {
        error(
            execute(&mut store, None, set("invalid", 2, invalid)),
            "invalid_argument",
        );
    }
    error(
        execute(&mut store, None, set("policy-1", 1, limits(16, 1, 1))),
        "idempotency_conflict",
    );
    let updated = execute(&mut store, None, set("policy-2", 2, limits(16, 3, 2))).unwrap();
    assert_eq!(updated["budget"]["revision"], 3);
    assert_eq!(execute(&mut store, None, first).unwrap(), saved);
    let recovered = execute(
        &mut store,
        None,
        json!({"action":"mutation","key":"policy-1"}),
    )
    .unwrap();
    assert_eq!(recovered, saved);
    assert_eq!(budgets::load(&store.0).unwrap().limits.max_sessions, 16);
    store.0.execute_batch("WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4094) INSERT INTO workflow_mutations(issuer,key,digest,view) SELECT 'capacity','policy-'||i,'hash','{}' FROM n;").unwrap();
    let head = store.cursors().unwrap();
    error(
        execute(&mut store, None, set("full", 3, limits(8, 8, 8))),
        "busy",
    );
    assert_eq!(store.cursors().unwrap(), head);
    assert_eq!(budgets::load(&store.0).unwrap().revision, 3);
    assert_eq!(
        execute(
            &mut store,
            None,
            json!({"action":"mutation","key":"policy-1"})
        )
        .unwrap(),
        saved
    );
}
#[tokio::test]
async fn journal_cache_uses_current_policy_after_replay_and_reopen() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-budgets-{}.sqlite",
        hex::encode(crate::wire::random::<12>())
    ));
    let log = Service::open(path.clone()).await.unwrap();
    let actor = Actor {
        issuer: "owner".into(),
        scope: Scope::Owner,
    };
    let request: Request = serde_json::from_value(set("first", 1, limits(12, 2, 1))).unwrap();
    let saved = log.workflow(actor.clone(), request.clone()).await.unwrap();
    log.workflow(
        actor.clone(),
        serde_json::from_value(set("second", 2, limits(16, 3, 2))).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(log.workflow(actor.clone(), request).await.unwrap(), saved);
    assert_eq!(log.budget().read().unwrap().as_ref().unwrap().revision, 3);
    assert_eq!(
        log.budget()
            .read()
            .unwrap()
            .as_ref()
            .unwrap()
            .limits
            .max_sessions,
        16
    );
    log.shutdown().await;
    drop(log);
    let reopened = Service::open(path.clone()).await.unwrap();
    assert_eq!(
        reopened.budget().read().unwrap().as_ref().unwrap().revision,
        3
    );
    assert_eq!(
        reopened
            .budget()
            .read()
            .unwrap()
            .as_ref()
            .unwrap()
            .limits
            .max_workers,
        3
    );
    let denied = Actor {
        issuer: "child".into(),
        scope: Scope::Worker("child".into()),
    };
    error(
        reopened
            .workflow(
                denied,
                serde_json::from_value(set("third", 3, limits(8, 8, 8))).unwrap(),
            )
            .await,
        "forbidden",
    );
    let current = reopened
        .workflow(
            actor,
            serde_json::from_value(json!({"action":"hostBudget","request":{"action":"get"}}))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(current["budget"]["revision"], 3);
    reopened.shutdown().await;
    drop(reopened);
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn failed_projection_refresh_never_keeps_a_permissive_obsolete_policy() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-budget-fault-{}.sqlite",
        hex::encode(crate::wire::random::<12>())
    ));
    let log = Service::open(path.clone()).await.unwrap();
    let corrupt = rusqlite::Connection::open(&path).unwrap();
    corrupt
        .execute("UPDATE host_budget SET data='{}' WHERE id=1", [])
        .unwrap();
    let owner = Actor {
        issuer: "owner".into(),
        scope: Scope::Owner,
    };
    let get =
        serde_json::from_value(json!({"action":"hostBudget","request":{"action":"get"}})).unwrap();
    assert!(log.workflow(owner, get).await.is_err());
    assert!(
        log.budget().read().unwrap().is_none(),
        "Failed refresh disables new admission, without touching live sessions"
    );
    log.shutdown().await;
    drop(log);
    drop(corrupt);
    std::fs::remove_file(path).unwrap();
}
