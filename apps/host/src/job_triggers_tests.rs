//! Storage/application invariants only; no HTTP, provider or process is launched here.
use super::Store;
use crate::{
    job_definitions as jobs,
    job_triggers::{self as triggers, Adapter, Inbound, Provider, Request, Spec},
    orchestration::{Actor, Scope},
};
use serde_json::{Value, json};

const NOW: u64 = 1_792_416_000_000;
fn secret() -> String {
    "a".repeat(64)
}
fn owner() -> Actor {
    Actor {
        issuer: "owner".into(),
        scope: Scope::Owner,
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
fn job_spec() -> Value {
    json!({"title":"External fixture","instruction":"FIXED OWNER INSTRUCTION","profile":{"program":"claude","workspace":"shared"},"schedule":{"kind":"external"},"overlap":"queue"})
}
fn job(store: &mut Store, key: &str) -> Value {
    jobs::execute(
        &mut store.0,
        owner(),
        serde_json::from_value(json!({"action":"create","key":key,"spec":job_spec()})).unwrap(),
        NOW,
    )
    .unwrap()["job"]
        .clone()
}
fn spec(job: &Value, adapter: Adapter) -> Spec {
    Spec {
        title: "Signed signal".into(),
        job_id: job["id"].as_str().unwrap().into(),
        job_revision: job["revision"].as_u64().unwrap(),
        adapter,
    }
}
fn manage(store: &mut Store, request: Request, now: u64) -> anyhow::Result<Value> {
    jobs::execute(
        &mut store.0,
        owner(),
        jobs::Request::Triggers { request },
        now,
    )
}
fn create(store: &mut Store, job: &Value, adapter: Adapter, key: &str, secret: &str) -> Value {
    manage(
        store,
        Request::Create {
            key: key.into(),
            spec: spec(job, adapter),
            secret: secret.into(),
        },
        NOW,
    )
    .unwrap()["trigger"]
        .clone()
}
fn enable(store: &mut Store, trigger: &Value, key: &str) -> Value {
    manage(
        store,
        Request::SetEnabled {
            key: key.into(),
            id: trigger["id"].as_str().unwrap().into(),
            expected_revision: trigger["revision"].as_u64().unwrap(),
            enabled: true,
        },
        NOW,
    )
    .unwrap()["trigger"]
        .clone()
}
fn fixture(enabled: bool) -> (Store, Value, Value) {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let job = job(&mut store, "job");
    let mut trigger = create(
        &mut store,
        &job,
        Adapter::Webhook {
            event: "build".into(),
        },
        "trigger",
        &secret(),
    );
    if enabled {
        trigger = enable(&mut store, &trigger, "enable");
    }
    (store, job, trigger)
}
fn signed(
    trigger: &Value,
    provider: Provider,
    secret: &str,
    delivery: &str,
    event: &str,
    body: Value,
) -> Inbound {
    let body = serde_json::to_vec(&body).unwrap();
    let signature = format!(
        "sha256={}",
        hex::encode(
            ring::hmac::sign(
                &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret.as_bytes()),
                &body
            )
            .as_ref()
        )
    );
    Inbound {
        provider,
        trigger_id: trigger["id"].as_str().unwrap().into(),
        delivery_id: delivery.into(),
        event: event.into(),
        signature,
        body,
    }
}
fn generic(trigger: &Value, key: &str, delivery: &str, at: u64) -> Inbound {
    signed(
        trigger,
        Provider::Webhook,
        key,
        delivery,
        "build",
        json!({"schemaVersion":1,"id":delivery,"event":"build","sentAt":at,"payload":{"instruction":"UNTRUSTED_PAYLOAD_NEVER_A_PROMPT","profile":{"program":"shell"}}}),
    )
}
fn count(store: &Store, table: &str) -> i64 {
    store
        .0
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn github() -> Adapter {
    Adapter::Github {
        repository_id: 42,
        repository: "owner/repo".into(),
        event: "push".into(),
        actions: vec![],
        branch: Some("main".into()),
    }
}
fn push() -> Value {
    json!({"repository":{"id":42,"full_name":"owner/repo"},"ref":"refs/heads/main","before":"1".repeat(40),"after":"2".repeat(40),"created":false,"deleted":false,"forced":false,"commits":[{"id":"2".repeat(40)}],"head_commit":{"id":"2".repeat(40)}})
}

#[test]
fn external_schedule_has_no_calendar_due_or_spontaneous_occurrence() {
    let (mut store, job, _) = fixture(false);
    assert!(job["nextDueAt"].is_null());
    assert_eq!(job["spec"]["schedule"], json!({"kind":"external"}));
    jobs::work(
        &mut store.0,
        jobs::Work::Poll { slots: 4 },
        NOW + 10_000_000,
    )
    .unwrap();
    let jobs::Reply::Calendars(due) =
        jobs::work(&mut store.0, jobs::Work::CalendarDue, NOW + 10_000_000).unwrap()
    else {
        panic!("Expected calendar work");
    };
    assert!(due.is_empty());
    assert_eq!(count(&store, "harness_job_occurrences"), 0);
    let answer = crate::job_calendar::evaluate(crate::job_calendar::Query {
        schedule: crate::job_calendar::Schedule::External,
        after: NOW,
    })
    .unwrap();
    assert!(answer.next.is_none() && answer.previous.is_none());
}

#[tokio::test]
async fn external_calendar_adapter_never_requires_a_helper() {
    let answer = crate::job_calendar_adapter::next(crate::job_calendar::Schedule::External, NOW)
        .await
        .unwrap();
    assert!(answer.next.is_none() && answer.previous.is_none());
}

#[test]
fn accepted_delivery_snapshots_only_authorized_job_policy_and_replays_without_writes() {
    let (mut store, _, trigger) = fixture(true);
    let accepted = triggers::ingest(
        &mut store.0,
        generic(&trigger, &secret(), "first", NOW),
        NOW,
    )
    .unwrap();
    assert!(!accepted.replayed);
    assert_eq!(accepted.view["delivery"]["disposition"], "queued");
    assert_eq!(accepted.view["delivery"].as_object().unwrap().len(), 12);
    assert!(!accepted.view.to_string().contains("UNTRUSTED_PAYLOAD"));
    assert!(!accepted.view.to_string().contains(&secret()));
    let occurrence = accepted.view["delivery"]["occurrenceId"].as_str().unwrap();
    let (kind, key, source): (String, String, String) = store
        .0
        .query_row(
            "SELECT trigger_kind,trigger_key,spec FROM harness_job_occurrences WHERE id=?1",
            [occurrence],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(kind, "external");
    assert!(key.starts_with(&format!("external:{}:", trigger["id"].as_str().unwrap())));
    assert_eq!(
        serde_json::from_str::<Value>(&source).unwrap()["instruction"],
        "FIXED OWNER INSTRUCTION"
    );
    assert!(!source.contains("UNTRUSTED_PAYLOAD"));
    let changes: i64 = store
        .0
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap();
    let replay = triggers::ingest(
        &mut store.0,
        generic(&trigger, &secret(), "first", NOW),
        NOW + 999_999,
    )
    .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.view, accepted.view);
    assert_eq!(
        store
            .0
            .query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        changes
    );
    assert_eq!(count(&store, "workflow_runs"), 0);
    assert_eq!(count(&store, "operation_receipts"), 0);
}

#[test]
fn disabled_delivery_stays_ignored_after_enable_and_new_delivery_can_queue() {
    let (mut store, _, trigger) = fixture(false);
    let ignored = triggers::ingest(
        &mut store.0,
        generic(&trigger, &secret(), "disabled", NOW),
        NOW,
    )
    .unwrap()
    .view;
    assert_eq!(ignored["delivery"]["reason"], "trigger_disabled");
    assert!(ignored["delivery"]["occurrenceId"].is_null());
    let trigger = enable(&mut store, &trigger, "now-enabled");
    assert_eq!(
        triggers::ingest(
            &mut store.0,
            generic(&trigger, &secret(), "disabled", NOW),
            NOW + 100
        )
        .unwrap()
        .view,
        ignored
    );
    assert_eq!(
        triggers::ingest(
            &mut store.0,
            generic(&trigger, &secret(), "fresh", NOW),
            NOW + 100
        )
        .unwrap()
        .view["delivery"]["disposition"],
        "queued"
    );
    assert_eq!(count(&store, "harness_job_occurrences"), 1);
}

#[test]
fn job_disable_pauses_external_queue_but_manual_intent_keeps_existing_semantics() {
    let (mut store, job, trigger) = fixture(true);
    let first = triggers::ingest(
        &mut store.0,
        generic(&trigger, &secret(), "queued-before-disable", NOW),
        NOW,
    )
    .unwrap()
    .view;
    jobs::execute(
        &mut store.0,
        owner(),
        jobs::Request::SetEnabled {
            key: "disable-job".into(),
            job_id: job["id"].as_str().unwrap().into(),
            expected_revision: 1,
            enabled: false,
        },
        NOW + 1,
    )
    .unwrap();
    let ignored = triggers::ingest(
        &mut store.0,
        generic(&trigger, &secret(), "while-disabled", NOW),
        NOW + 2,
    )
    .unwrap()
    .view;
    assert_eq!(ignored["delivery"]["reason"], "job_disabled");
    let jobs::Reply::Claims(claims) =
        jobs::work(&mut store.0, jobs::Work::Poll { slots: 4 }, NOW + 3).unwrap()
    else {
        panic!("Expected claims");
    };
    assert!(claims.is_empty());
    assert_eq!(count(&store, "harness_job_attempts"), 0);
    jobs::execute(
        &mut store.0,
        owner(),
        jobs::Request::SetEnabled {
            key: "enable-job".into(),
            job_id: job["id"].as_str().unwrap().into(),
            expected_revision: 2,
            enabled: true,
        },
        NOW + 4,
    )
    .unwrap();
    assert_eq!(
        triggers::ingest(
            &mut store.0,
            generic(&trigger, &secret(), "while-disabled", NOW),
            NOW + 5
        )
        .unwrap()
        .view,
        ignored
    );
    let accepted = triggers::ingest(
        &mut store.0,
        generic(&trigger, &secret(), "after-toggle", NOW),
        NOW + 5,
    )
    .unwrap()
    .view;
    assert_ne!(accepted["delivery"]["reason"], "job_config_changed");
    assert_eq!(accepted["delivery"]["jobRevision"], 3);
    assert_eq!(
        triggers::ingest(
            &mut store.0,
            generic(&trigger, &secret(), "queued-before-disable", NOW),
            NOW + 6
        )
        .unwrap()
        .view,
        first
    );

    let mut other = Store::open(std::path::Path::new(":memory:")).unwrap();
    let manual_job = self::job(&mut other, "manual-job");
    jobs::execute(
        &mut other.0,
        owner(),
        jobs::Request::SetEnabled {
            key: "disabled-manual-job".into(),
            job_id: manual_job["id"].as_str().unwrap().into(),
            expected_revision: 1,
            enabled: false,
        },
        NOW,
    )
    .unwrap();
    let manual = jobs::execute(
        &mut other.0,
        owner(),
        jobs::Request::RunNow {
            key: "manual".into(),
            job_id: manual_job["id"].as_str().unwrap().into(),
            expected_revision: 2,
        },
        NOW,
    )
    .unwrap();
    assert_eq!(manual["occurrence"]["trigger"], "manual");
    let jobs::Reply::Claims(claims) =
        jobs::work(&mut other.0, jobs::Work::Poll { slots: 1 }, NOW).unwrap()
    else {
        panic!("Expected manual claim");
    };
    assert_eq!(claims.len(), 1);
}

#[test]
fn edited_job_needs_explicit_owner_reauthorization_and_ignored_body_remains_ignored() {
    let (mut store, job, trigger) = fixture(true);
    let mut edited = job_spec();
    edited["instruction"] = "CHANGED OWNER POLICY".into();
    let changed=jobs::execute(&mut store.0,owner(),serde_json::from_value(json!({"action":"update","key":"edit-job","jobId":job["id"],"expectedRevision":1,"spec":edited})).unwrap(),NOW).unwrap()["job"].clone();
    let ignored = triggers::ingest(
        &mut store.0,
        generic(&trigger, &secret(), "old-authorization", NOW),
        NOW,
    )
    .unwrap()
    .view;
    assert_eq!(ignored["delivery"]["reason"], "job_config_changed");
    let updated = manage(
        &mut store,
        Request::Update {
            key: "reauthorize".into(),
            id: trigger["id"].as_str().unwrap().into(),
            expected_revision: 2,
            spec: spec(
                &changed,
                Adapter::Webhook {
                    event: "build".into(),
                },
            ),
        },
        NOW,
    )
    .unwrap()["trigger"]
        .clone();
    assert_eq!(
        triggers::ingest(
            &mut store.0,
            generic(&updated, &secret(), "old-authorization", NOW),
            NOW
        )
        .unwrap()
        .view,
        ignored
    );
    let fresh = triggers::ingest(
        &mut store.0,
        generic(&updated, &secret(), "new-authorization", NOW),
        NOW,
    )
    .unwrap()
    .view;
    assert_eq!(fresh["delivery"]["disposition"], "queued");
    let saved: String = store
        .0
        .query_row(
            "SELECT spec FROM harness_job_occurrences WHERE id=?1",
            [fresh["delivery"]["occurrenceId"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&saved).unwrap()["instruction"],
        "CHANGED OWNER POLICY"
    );
}

#[test]
fn rotation_authenticates_only_current_epoch_and_revocation_is_permanent() {
    let (mut store, _, trigger) = fixture(true);
    let original = triggers::ingest(
        &mut store.0,
        generic(&trigger, &secret(), "accepted", NOW),
        NOW,
    )
    .unwrap()
    .view;
    let rotate = Request::Rotate {
        key: "rotate".into(),
        id: trigger["id"].as_str().unwrap().into(),
        expected_revision: 2,
        secret: "b".repeat(64),
    };
    let rotated = manage(&mut store, rotate.clone(), NOW + 1).unwrap();
    assert_eq!(rotated["trigger"]["credentialGeneration"], 2);
    code(
        triggers::ingest(
            &mut store.0,
            generic(&trigger, &secret(), "accepted", NOW),
            NOW + 2,
        ),
        "trigger_unauthorized",
    );
    let replay = triggers::ingest(
        &mut store.0,
        generic(&trigger, &"b".repeat(64), "accepted", NOW),
        NOW + 2,
    )
    .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.view, original);
    assert_eq!(replay.view["delivery"]["credentialGeneration"], 1);
    manage(
        &mut store,
        Request::Revoke {
            key: "revoke".into(),
            id: trigger["id"].as_str().unwrap().into(),
            expected_revision: 3,
        },
        NOW + 3,
    )
    .unwrap();
    code(
        triggers::ingest(
            &mut store.0,
            generic(&trigger, &"b".repeat(64), "accepted", NOW),
            NOW + 4,
        ),
        "trigger_unauthorized",
    );
    code(
        manage(
            &mut store,
            Request::SetEnabled {
                key: "resurrect".into(),
                id: trigger["id"].as_str().unwrap().into(),
                expected_revision: 4,
                enabled: true,
            },
            NOW + 4,
        ),
        "trigger_revoked",
    );
    assert_eq!(manage(&mut store, rotate, NOW + 5).unwrap(), rotated);
    assert_eq!(
        store
            .0
            .query_row(
                "SELECT count(*) FROM harness_job_trigger_credentials WHERE secret IS NOT NULL",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn retired_secrets_cannot_cross_trigger_routes_or_be_reused_on_rotation() {
    let (mut store, job, trigger) = fixture(true);
    manage(
        &mut store,
        Request::Rotate {
            key: "rotate".into(),
            id: trigger["id"].as_str().unwrap().into(),
            expected_revision: 2,
            secret: "b".repeat(64),
        },
        NOW,
    )
    .unwrap();
    for value in [secret(), "b".repeat(64)] {
        code(
            manage(
                &mut store,
                Request::Create {
                    key: format!("reuse-{value}"),
                    spec: spec(
                        &job,
                        Adapter::Webhook {
                            event: "build".into(),
                        },
                    ),
                    secret: value,
                },
                NOW,
            ),
            "invalid_argument",
        );
    }
    code(
        manage(
            &mut store,
            Request::Rotate {
                key: "reuse-old".into(),
                id: trigger["id"].as_str().unwrap().into(),
                expected_revision: 3,
                secret: secret(),
            },
            NOW,
        ),
        "invalid_argument",
    );
    assert_eq!(count(&store, "harness_job_triggers"), 1);
    assert_eq!(count(&store, "harness_job_trigger_credentials"), 2);
    assert_eq!(
        manage(
            &mut store,
            Request::Get {
                id: trigger["id"].as_str().unwrap().into()
            },
            NOW
        )
        .unwrap()["trigger"]["revision"],
        3
    );
}

#[test]
fn generic_headers_body_binding_signature_and_provider_provenance_fail_closed() {
    let (mut store, _, trigger) = fixture(true);
    for case in 0..7 {
        let mut inbound = generic(&trigger, &secret(), "bound", NOW);
        match case {
            0 => inbound.delivery_id = "changed-header".into(),
            1 => inbound.event = "changed-event".into(),
            2 => inbound.provider = Provider::Github,
            3 => inbound.body.push(b' '),
            4 => inbound.signature = "sha256=".into(),
            5 => inbound.trigger_id = "0".repeat(32),
            _ => inbound.signature = inbound.signature.to_ascii_uppercase(),
        };
        let expected = if case < 2 {
            "invalid_argument"
        } else {
            "trigger_unauthorized"
        };
        code(triggers::ingest(&mut store.0, inbound, NOW), expected);
    }
    assert_eq!(count(&store, "harness_job_trigger_deliveries"), 0);
    assert_eq!(count(&store, "harness_job_occurrences"), 0);
}

#[test]
fn generic_schema_and_fresh_timestamp_boundaries_are_strict_but_replay_keeps_original_time() {
    let (mut store, _, trigger) = fixture(true);
    for field in ["schemaVersion", "id", "event", "sentAt", "payload"] {
        let mut body =
            json!({"schemaVersion":1,"id":"missing","event":"build","sentAt":NOW,"payload":null});
        body.as_object_mut().unwrap().remove(field);
        code(
            triggers::ingest(
                &mut store.0,
                signed(
                    &trigger,
                    Provider::Webhook,
                    &secret(),
                    "missing",
                    "build",
                    body,
                ),
                NOW,
            ),
            "invalid_argument",
        );
    }
    for at in [NOW - 300_001, NOW + 300_001] {
        code(
            triggers::ingest(&mut store.0, generic(&trigger, &secret(), "stale", at), NOW),
            "invalid_argument",
        );
    }
    for (key, at) in [("past-edge", NOW - 300_000), ("future-edge", NOW + 300_000)] {
        assert!(
            !triggers::ingest(&mut store.0, generic(&trigger, &secret(), key, at), NOW)
                .unwrap()
                .replayed
        );
    }
    let original = triggers::ingest(
        &mut store.0,
        generic(&trigger, &secret(), "past-edge", NOW - 300_000),
        NOW + 5_000_000,
    )
    .unwrap();
    assert!(original.replayed);
    assert_eq!(original.view["delivery"]["acceptedAt"], NOW);
}

#[test]
fn sender_id_conflict_and_github_unsigned_id_alias_never_mint_second_work() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let job = job(&mut store, "job");
    let created = create(&mut store, &job, github(), "github", &secret());
    let trigger = enable(&mut store, &created, "enable");
    let first = triggers::ingest(
        &mut store.0,
        signed(
            &trigger,
            Provider::Github,
            &secret(),
            "github-delivery",
            "push",
            push(),
        ),
        NOW,
    )
    .unwrap();
    let alias = triggers::ingest(
        &mut store.0,
        signed(
            &trigger,
            Provider::Github,
            &secret(),
            "unsigned-alias",
            "push",
            push(),
        ),
        NOW + 999_999,
    )
    .unwrap();
    assert!(alias.replayed);
    assert_eq!(alias.view, first.view);
    let mut changed = push();
    changed["ref"] = "refs/heads/other".into();
    code(
        triggers::ingest(
            &mut store.0,
            signed(
                &trigger,
                Provider::Github,
                &secret(),
                "github-delivery",
                "push",
                changed,
            ),
            NOW,
        ),
        "invalid_argument",
    );
    assert_eq!(count(&store, "harness_job_trigger_deliveries"), 1);
    assert_eq!(count(&store, "harness_job_occurrences"), 1);
    assert_eq!(
        manage(
            &mut store,
            Request::Delivery {
                id: trigger["id"].as_str().unwrap().into(),
                delivery_id: "github-delivery".into()
            },
            NOW
        )
        .unwrap(),
        first.view
    );
    code(
        manage(
            &mut store,
            Request::Delivery {
                id: trigger["id"].as_str().unwrap().into(),
                delivery_id: first.view["delivery"]["id"].as_str().unwrap().into(),
            },
            NOW,
        ),
        "job_trigger_delivery_not_found",
    );
}

#[test]
fn github_repository_branch_event_and_action_policies_are_scoped_to_signed_payload_shapes() {
    for mutation in 0..3 {
        let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let job = job(&mut store, "job");
        let created = create(&mut store, &job, github(), "github", &secret());
        let trigger = enable(&mut store, &created, "enable");
        let mut body = push();
        match mutation {
            0 => body["repository"]["id"] = json!(43),
            1 => body["repository"]["full_name"] = "other/repo".into(),
            _ => body["ref"] = "refs/heads/other".into(),
        };
        let accepted = triggers::ingest(
            &mut store.0,
            signed(
                &trigger,
                Provider::Github,
                &secret(),
                "filtered",
                "push",
                body,
            ),
            NOW,
        )
        .unwrap();
        assert_eq!(accepted.view["delivery"]["reason"], "filter_mismatch");
        assert!(accepted.view["delivery"]["occurrenceId"].is_null());
        assert_eq!(count(&store, "harness_job_occurrences"), 0);
    }
    for (event, actions, body) in [
        (
            "pull_request",
            vec!["opened".into()],
            json!({"repository":{"id":42,"full_name":"owner/repo"},"action":"opened","number":1,"pull_request":{"base":{"ref":"main"}}}),
        ),
        (
            "workflow_run",
            vec!["completed".into()],
            json!({"repository":{"id":42,"full_name":"owner/repo"},"action":"completed","workflow_run":{"id":7,"head_branch":"main","status":"completed"}}),
        ),
    ] {
        let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let job = job(&mut store, "job");
        let created = create(
            &mut store,
            &job,
            Adapter::Github {
                repository_id: 42,
                repository: "owner/repo".into(),
                event: event.into(),
                actions,
                branch: Some("main".into()),
            },
            "github",
            &secret(),
        );
        let trigger = enable(&mut store, &created, "enable");
        assert_eq!(
            triggers::ingest(
                &mut store.0,
                signed(&trigger, Provider::Github, &secret(), event, event, body),
                NOW
            )
            .unwrap()
            .view["delivery"]["disposition"],
            "queued"
        );
        code(
            triggers::ingest(
                &mut store.0,
                signed(
                    &trigger,
                    Provider::Github,
                    &secret(),
                    "wrong-shape",
                    "push",
                    json!({"repository":{"id":42,"full_name":"owner/repo"},"action":"completed"}),
                ),
                NOW,
            ),
            "invalid_argument",
        );
    }
}

#[test]
fn owner_scope_revision_binding_required_branch_and_immutable_mutations_preserve_secrets() {
    let (mut store, job, trigger) = fixture(false);
    let create = Request::Create {
        key: "trigger".into(),
        spec: spec(
            &job,
            Adapter::Webhook {
                event: "build".into(),
            },
        ),
        secret: secret(),
    };
    assert_eq!(
        manage(&mut store, create.clone(), NOW + 999).unwrap()["trigger"],
        trigger
    );
    for scope in [
        Scope::Coordinator("coordinator".into()),
        Scope::Worker("worker".into()),
    ] {
        code(
            triggers::execute(
                &mut store.0,
                Actor {
                    issuer: "owner".into(),
                    scope,
                },
                create.clone(),
                NOW,
            ),
            "forbidden",
        );
    }
    let mut changed = create;
    if let Request::Create { secret, .. } = &mut changed {
        *secret = "b".repeat(64);
    }
    code(manage(&mut store, changed, NOW), "idempotency_conflict");
    let mut wire = serde_json::to_value(github()).unwrap();
    wire.as_object_mut().unwrap().remove("branch");
    assert!(serde_json::from_value::<Adapter>(wire).is_err());
    let mut stale = spec(
        &job,
        Adapter::Webhook {
            event: "build".into(),
        },
    );
    stale.job_revision = 2;
    code(
        manage(
            &mut store,
            Request::Update {
                key: "stale-job".into(),
                id: trigger["id"].as_str().unwrap().into(),
                expected_revision: 1,
                spec: stale,
            },
            NOW,
        ),
        "revision_conflict",
    );
    code(
        manage(
            &mut store,
            Request::Update {
                key: "provider-flip".into(),
                id: trigger["id"].as_str().unwrap().into(),
                expected_revision: 1,
                spec: spec(&job, github()),
            },
            NOW,
        ),
        "invalid_argument",
    );
    let rows = manage(&mut store, Request::List { offset: 0 }, NOW).unwrap();
    assert!(!rows.to_string().contains(&secret()));
    let retained: String = store
        .0
        .query_row(
            "SELECT view FROM harness_job_trigger_mutations WHERE key='trigger'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!retained.contains(&secret()));
    let events = store
        .0
        .prepare("SELECT payload FROM domain_events")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(events.iter().all(|event| !event.contains(&secret())));
}

#[test]
fn burst_limits_persist_and_backward_time_cannot_reset_them_while_replay_is_quiet() {
    let (mut store, _, trigger) = fixture(true);
    let first = triggers::ingest(
        &mut store.0,
        generic(&trigger, &secret(), "event-0", NOW),
        NOW,
    )
    .unwrap()
    .view;
    code(
        triggers::ingest(
            &mut store.0,
            generic(&trigger, &secret(), "backwards", NOW - 1),
            NOW - 1,
        ),
        "trigger_rate_limited",
    );
    for i in 1..10 {
        triggers::ingest(
            &mut store.0,
            generic(&trigger, &secret(), &format!("event-{i}"), NOW),
            NOW,
        )
        .unwrap();
    }
    code(
        triggers::ingest(
            &mut store.0,
            generic(&trigger, &secret(), "event-10", NOW),
            NOW,
        ),
        "trigger_rate_limited",
    );
    assert_eq!(
        triggers::ingest(
            &mut store.0,
            generic(&trigger, &secret(), "event-0", NOW),
            NOW
        )
        .unwrap()
        .view,
        first
    );
    assert_eq!(count(&store, "harness_job_trigger_deliveries"), 10);
    assert!(
        !triggers::ingest(
            &mut store.0,
            generic(&trigger, &secret(), "event-10", NOW),
            NOW + 60_000
        )
        .unwrap()
        .replayed
    );
    assert_eq!(count(&store, "harness_job_trigger_deliveries"), 11);
}

#[test]
fn overlap_rules_apply_to_external_occurrences_and_failed_admission_rolls_back_delivery() {
    let (mut store, job, trigger) = fixture(true);
    let first = triggers::ingest(
        &mut store.0,
        generic(&trigger, &secret(), "first", NOW),
        NOW,
    )
    .unwrap()
    .view;
    let second = triggers::ingest(
        &mut store.0,
        generic(&trigger, &secret(), "second", NOW),
        NOW,
    )
    .unwrap()
    .view;
    assert_eq!(first["delivery"]["disposition"], "queued");
    assert_eq!(second["delivery"]["reason"], "queue_full");
    assert_eq!(second["delivery"]["disposition"], "skipped");
    assert_eq!(count(&store, "harness_job_trigger_deliveries"), 2);
    // Simulate an exhausted occurrence journal without executing any work.
    store.0.execute("CREATE TRIGGER fixture_refuse_external BEFORE INSERT ON harness_job_occurrences BEGIN SELECT RAISE(ABORT,'fixture admission refusal'); END",[]).unwrap();
    assert!(
        triggers::ingest(
            &mut store.0,
            generic(&trigger, &secret(), "not-accepted", NOW),
            NOW
        )
        .is_err()
    );
    assert_eq!(count(&store, "harness_job_trigger_deliveries"), 2);
    assert_eq!(count(&store, "harness_job_occurrences"), 2);
    assert_eq!(job["id"], first["delivery"]["jobId"]);
}

#[test]
fn restart_preserves_accepted_receipts_ignored_outcomes_and_current_credentials() {
    let path = std::env::temp_dir().join(format!(
        "nesvo-trigger-{}.sqlite",
        hex::encode(crate::wire::random::<8>())
    ));
    let trigger;
    let first;
    {
        let mut store = Store::open(&path).unwrap();
        let job = job(&mut store, "job");
        let created = create(
            &mut store,
            &job,
            Adapter::Webhook {
                event: "build".into(),
            },
            "trigger",
            &secret(),
        );
        trigger = enable(&mut store, &created, "enable");
        first = triggers::ingest(
            &mut store.0,
            generic(&trigger, &secret(), "persisted", NOW),
            NOW,
        )
        .unwrap()
        .view;
    }
    {
        let mut store = Store::open(&path).unwrap();
        let replay = triggers::ingest(
            &mut store.0,
            generic(&trigger, &secret(), "persisted", NOW),
            NOW + 999999,
        )
        .unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.view, first);
        assert_eq!(count(&store, "harness_job_occurrences"), 1);
        assert_eq!(count(&store, "workflow_runs"), 0);
    }
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn restricted_writer_serializes_concurrent_duplicates_without_owner_scope_elevation() {
    let service = crate::event_log::Service::open(std::path::PathBuf::from(":memory:"))
        .await
        .unwrap();
    let job=service.workflow(owner(),serde_json::from_value(json!({"action":"jobs","request":{"action":"create","key":"job","spec":job_spec()}})).unwrap()).await.unwrap()["job"].clone();
    let created=service.workflow(owner(),serde_json::from_value(json!({"action":"jobs","request":{"action":"triggers","request":{"action":"create","key":"trigger","spec":spec(&job,Adapter::Webhook {event:"build".into()}),"secret":secret()}}})).unwrap()).await.unwrap()["trigger"].clone();
    let trigger=service.workflow(owner(),serde_json::from_value(json!({"action":"jobs","request":{"action":"triggers","request":{"action":"setEnabled","key":"enable","id":created["id"],"expectedRevision":1,"enabled":true}}})).unwrap()).await.unwrap()["trigger"].clone();
    let at = crate::status::now_millis();
    let (a, b, c) = tokio::join!(
        service.external_trigger(generic(&trigger, &secret(), "race", at)),
        service.external_trigger(generic(&trigger, &secret(), "race", at)),
        service.external_trigger(generic(&trigger, &secret(), "race", at))
    );
    let values = [a.unwrap(), b.unwrap(), c.unwrap()];
    assert_eq!(values.iter().filter(|v| !v.replayed).count(), 1);
    assert!(values.iter().all(|v| v.view == values[0].view));
    let deliveries=service.workflow(owner(),serde_json::from_value(json!({"action":"jobs","request":{"action":"triggers","request":{"action":"deliveries","id":trigger["id"]}}})).unwrap()).await.unwrap();
    assert_eq!(deliveries["deliveries"].as_array().unwrap().len(), 1);
    service.shutdown().await;
}

#[test]
fn full_management_journal_preserves_one_permanent_revocation_reserve_and_exact_replay() {
    let (mut store, _, trigger) = fixture(true);
    // Capacity-shaped retained responses exercise the reserve without thousands
    // of irrelevant management transitions or any native/session activity.
    store.0.execute("WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<4094) INSERT INTO harness_job_trigger_mutations(issuer,key,digest,view) SELECT 'owner','retained-'||n,'retained','{}' FROM rows",[]).unwrap();
    assert_eq!(count(&store, "harness_job_trigger_mutations"), 4096);
    code(
        manage(
            &mut store,
            Request::SetEnabled {
                key: "ordinary-full".into(),
                id: trigger["id"].as_str().unwrap().into(),
                expected_revision: 2,
                enabled: false,
            },
            NOW,
        ),
        "busy",
    );
    let revoke = Request::Revoke {
        key: "emergency-revoke".into(),
        id: trigger["id"].as_str().unwrap().into(),
        expected_revision: 2,
    };
    let accepted = manage(&mut store, revoke.clone(), NOW).unwrap();
    assert_eq!(accepted["trigger"]["revoked"], true);
    assert_eq!(count(&store, "harness_job_trigger_mutations"), 4097);
    assert_eq!(manage(&mut store, revoke, NOW + 100).unwrap(), accepted);
    code(
        manage(
            &mut store,
            Request::Revoke {
                key: "cannot-spend-reserve-twice".into(),
                id: trigger["id"].as_str().unwrap().into(),
                expected_revision: 3,
            },
            NOW + 100,
        ),
        "trigger_revoked",
    );
    assert_eq!(count(&store, "harness_job_trigger_mutations"), 4097);
    code(
        triggers::ingest(
            &mut store.0,
            generic(&trigger, &secret(), "revoked", NOW),
            NOW,
        ),
        "trigger_unauthorized",
    );
}

#[test]
fn retained_delivery_capacity_fails_closed_without_evicting_replay_evidence() {
    let (mut store, _, trigger) = fixture(true);
    let accepted = triggers::ingest(
        &mut store.0,
        generic(&trigger, &secret(), "original", NOW),
        NOW,
    )
    .unwrap()
    .view;
    let old = i64::try_from(NOW - 60_001).unwrap();
    store.0.execute("WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<4095)
        INSERT INTO harness_job_trigger_deliveries(id,trigger_id,delivery_id,raw_sha256,credential_generation,trigger_revision,job_id,job_revision,accepted_at,disposition,reason,occurrence_id,view)
        SELECT printf('%032x',n),d.trigger_id,'retained-'||n,printf('%064x',n),d.credential_generation,d.trigger_revision,d.job_id,d.job_revision,?1,'ignored','fixture_retention',NULL,
            json_set(d.view,'$.delivery.id',printf('%032x',n),'$.delivery.deliveryId','retained-'||n,'$.delivery.bodyDigest',printf('%064x',n),'$.delivery.acceptedAt',?1,'$.delivery.disposition','ignored','$.delivery.reason','fixture_retention','$.delivery.occurrenceId',NULL)
        FROM rows JOIN harness_job_trigger_deliveries d ON d.delivery_id='original'",[old]).unwrap();
    assert_eq!(count(&store, "harness_job_trigger_deliveries"), 4096);
    code(
        triggers::ingest(
            &mut store.0,
            generic(&trigger, &secret(), "full", NOW + 60_001),
            NOW + 60_001,
        ),
        "busy",
    );
    assert_eq!(
        triggers::ingest(
            &mut store.0,
            generic(&trigger, &secret(), "original", NOW),
            NOW + 60_001
        )
        .unwrap()
        .view,
        accepted
    );
    assert_eq!(count(&store, "harness_job_trigger_deliveries"), 4096);
    assert_eq!(count(&store, "harness_job_occurrences"), 1);
}

#[test]
fn trigger_retention_and_delivery_read_membership_are_bounded() {
    let (mut store, job, trigger) = fixture(true);
    let accepted = triggers::ingest(
        &mut store.0,
        generic(&trigger, &secret(), "known-sender", NOW),
        NOW,
    )
    .unwrap()
    .view;
    let mut another = Value::Null;
    for n in 0..127 {
        another = create(
            &mut store,
            &job,
            Adapter::Webhook {
                event: "build".into(),
            },
            &format!("route-{n}"),
            &format!("{n:064x}"),
        );
    }
    assert_eq!(count(&store, "harness_job_triggers"), 128);
    code(
        manage(
            &mut store,
            Request::Create {
                key: "over-capacity".into(),
                spec: spec(
                    &job,
                    Adapter::Webhook {
                        event: "build".into(),
                    },
                ),
                secret: "c".repeat(64),
            },
            NOW,
        ),
        "busy",
    );
    let page = manage(&mut store, Request::List { offset: 0 }, NOW).unwrap();
    assert_eq!(page["triggers"].as_array().unwrap().len(), 8);
    assert_eq!(page["nextOffset"], 8);
    code(
        manage(
            &mut store,
            Request::Delivery {
                id: another["id"].as_str().unwrap().into(),
                delivery_id: "known-sender".into(),
            },
            NOW,
        ),
        "job_trigger_delivery_not_found",
    );
    assert_eq!(
        manage(
            &mut store,
            Request::Delivery {
                id: trigger["id"].as_str().unwrap().into(),
                delivery_id: "known-sender".into()
            },
            NOW
        )
        .unwrap(),
        accepted
    );
    assert!(manage(&mut store, Request::List { offset: 4097 }, NOW).is_err());
}

#[test]
fn hmac_key_is_ascii_secret_and_exact_unicode_body_bytes_are_not_canonicalized() {
    let (mut store, _, trigger) = fixture(true);
    let body = json!({"schemaVersion":1,"id":"unicode","event":"build","sentAt":NOW,"payload":{"text":"Żółć 🌌"}});
    let mut decoded = signed(
        &trigger,
        Provider::Webhook,
        &secret(),
        "unicode",
        "build",
        body.clone(),
    );
    decoded.signature = format!(
        "sha256={}",
        hex::encode(
            ring::hmac::sign(
                &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &hex::decode(secret()).unwrap()),
                &decoded.body
            )
            .as_ref()
        )
    );
    code(
        triggers::ingest(&mut store.0, decoded, NOW),
        "trigger_unauthorized",
    );
    let accepted = triggers::ingest(
        &mut store.0,
        signed(
            &trigger,
            Provider::Webhook,
            &secret(),
            "unicode",
            "build",
            body.clone(),
        ),
        NOW,
    )
    .unwrap();
    let mut whitespace = signed(
        &trigger,
        Provider::Webhook,
        &secret(),
        "unicode",
        "build",
        body,
    );
    whitespace.body =
        serde_json::to_vec_pretty(&serde_json::from_slice::<Value>(&whitespace.body).unwrap())
            .unwrap();
    whitespace.signature = format!(
        "sha256={}",
        hex::encode(
            ring::hmac::sign(
                &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret().as_bytes()),
                &whitespace.body
            )
            .as_ref()
        )
    );
    code(
        triggers::ingest(&mut store.0, whitespace, NOW),
        "invalid_argument",
    );
    assert_eq!(count(&store, "harness_job_trigger_deliveries"), 1);
    assert_eq!(accepted.view["delivery"]["deliveryId"], "unicode");
}

#[test]
fn unsigned_event_header_cannot_relabel_a_workflow_dispatch_or_review_payload() {
    let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let job = job(&mut store, "job");
    let created = create(&mut store, &job, github(), "github", &secret());
    let trigger = enable(&mut store, &created, "enable");
    let dispatch = json!({"repository":{"id":42,"full_name":"owner/repo"},"ref":"refs/heads/main","inputs":{"message":"Untrusted workflow dispatch"},"workflow":"workflow.yml"});
    code(
        triggers::ingest(
            &mut store.0,
            signed(
                &trigger,
                Provider::Github,
                &secret(),
                "relabel-dispatch",
                "push",
                dispatch,
            ),
            NOW,
        ),
        "invalid_argument",
    );
    for field in [
        "before",
        "after",
        "created",
        "deleted",
        "forced",
        "commits",
        "head_commit",
    ] {
        let mut body = push();
        body.as_object_mut().unwrap().remove(field);
        code(
            triggers::ingest(
                &mut store.0,
                signed(&trigger, Provider::Github, &secret(), field, "push", body),
                NOW,
            ),
            "invalid_argument",
        );
    }
    for field in ["created", "deleted", "forced"] {
        let mut body = push();
        body[field] = json!(0);
        code(
            triggers::ingest(
                &mut store.0,
                signed(&trigger, Provider::Github, &secret(), field, "push", body),
                NOW,
            ),
            "invalid_argument",
        );
    }
    let mut body = push();
    body["before"] = "1".repeat(64).into();
    code(
        triggers::ingest(
            &mut store.0,
            signed(
                &trigger,
                Provider::Github,
                &secret(),
                "sha-width",
                "push",
                body,
            ),
            NOW,
        ),
        "invalid_argument",
    );
    let mut body = push();
    body["after"] = "A".repeat(40).into();
    code(
        triggers::ingest(
            &mut store.0,
            signed(
                &trigger,
                Provider::Github,
                &secret(),
                "sha-case",
                "push",
                body,
            ),
            NOW,
        ),
        "invalid_argument",
    );
    assert_eq!(count(&store, "harness_job_trigger_deliveries"), 0);
    assert_eq!(count(&store, "harness_job_occurrences"), 0);
    let mut pull_request = spec(&job, github());
    pull_request.adapter = Adapter::Github {
        repository_id: 42,
        repository: "owner/repo".into(),
        event: "pull_request".into(),
        actions: vec!["submitted".into()],
        branch: None,
    };
    code(
        manage(
            &mut store,
            Request::Create {
                key: "review-action-is-not-pr-action".into(),
                spec: pull_request,
                secret: "b".repeat(64),
            },
            NOW,
        ),
        "invalid_argument",
    );
    let created = create(
        &mut store,
        &job,
        Adapter::Github {
            repository_id: 42,
            repository: "owner/repo".into(),
            event: "pull_request".into(),
            actions: vec!["edited".into()],
            branch: None,
        },
        "pull-request",
        &"b".repeat(64),
    );
    let trigger = enable(&mut store, &created, "enable-pr");
    let review = json!({"repository":{"id":42,"full_name":"owner/repo"},"number":1,"action":"edited","pull_request":{"base":{"ref":"main"}},"review":{"id":7}});
    code(
        triggers::ingest(
            &mut store.0,
            signed(
                &trigger,
                Provider::Github,
                &"b".repeat(64),
                "review-relabel",
                "pull_request",
                review,
            ),
            NOW,
        ),
        "invalid_argument",
    );
    assert_eq!(count(&store, "harness_job_trigger_deliveries"), 0);
}

#[test]
fn webhook_colon_event_and_wellformed_github_tag_filter_keep_advertised_scope() {
    let (mut store, job, trigger) = fixture(true);
    let mut updated_spec = spec(
        &job,
        Adapter::Webhook {
            event: "build:finished".into(),
        },
    );
    updated_spec.title = "Colon event".into();
    let trigger = manage(
        &mut store,
        Request::Update {
            key: "colon-event".into(),
            id: trigger["id"].as_str().unwrap().into(),
            expected_revision: 2,
            spec: updated_spec,
        },
        NOW,
    )
    .unwrap()["trigger"]
        .clone();
    let body = json!({"schemaVersion":1,"id":"colon","event":"build:finished","sentAt":NOW,"payload":null});
    assert_eq!(
        triggers::ingest(
            &mut store.0,
            signed(
                &trigger,
                Provider::Webhook,
                &secret(),
                "colon",
                "build:finished",
                body
            ),
            NOW
        )
        .unwrap()
        .view["delivery"]["disposition"],
        "queued"
    );
    let created = create(&mut store, &job, github(), "tag-filter", &"b".repeat(64));
    let trigger = enable(&mut store, &created, "tag-enable");
    let mut body = push();
    body["ref"] = "refs/tags/release".into();
    assert_eq!(
        triggers::ingest(
            &mut store.0,
            signed(
                &trigger,
                Provider::Github,
                &"b".repeat(64),
                "tag",
                "push",
                body
            ),
            NOW
        )
        .unwrap()
        .view["delivery"]["reason"],
        "filter_mismatch"
    );
}
