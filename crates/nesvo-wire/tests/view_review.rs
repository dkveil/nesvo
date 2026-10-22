use nesvo_wire::views::{
    self,
    review::{
        DeliverReview, DeliveryPath, DiffReply, OpenReview, OpenedScope, ReviewContext,
        ReviewContextRequest, ReviewDelivered, ReviewDiffRequest, ReviewOpened, ReviewProgress,
        ReviewSource, ReviewSourceKind, SessionDiffRequest, WatchReviews,
    },
};
use serde_json::{Value, json};

const PULL_OPENED: &str = r#"{"type":"reviewOpened","requestId":"tui-1-4","reviewId":"pull-o-r-5",
  "directory":"/cfg/nesvo/reviews/o-r-5",
  "source":{"kind":"pull","url":"https://github.com/o/r/pull/5","owner":"o","repo":"r","number":5,
    "title":"Fix the tree","state":"OPEN","headRef":"topic","baseRef":"main","headOid":"abc"},
  "base":{"ref":"main","oid":"0123456789abcdef","mergeBase":"0123"},
  "head":{"ref":"topic","oid":"fedcba9876543210"},"scope":"branch","revision":"tree-hash",
  "checks":{"headOid":"fedcba9876543210","total":3,"passed":2,"failed":0,"pending":1}}"#;

const LOCAL_OPENED: &str = r#"{"type":"reviewOpened","reviewId":"local-0123456789abcdef",
  "directory":"/w","source":{"kind":"local","sessionId":"s","context":"agent folder"},
  "base":null,"head":{"ref":null,"oid":null},"scope":"unstaged","revision":"r1","checks":null}"#;

const CONTEXT: &str = r#"{"type":"reviewContext","requestId":"tui-1-6","reviewId":"local-abc","directory":"/w",
  "readiness":{"blockers":["dirty","unpushed"],"ready":false,"branch":"topic","unstaged":1,
    "base":{"ref":"main","behind":2,"ahead":1}},
  "provenance":{"evidence":"hooks","sessionId":"s","turn":3,"complete":true,"truncated":false,
    "files":[{"path":"a.txt","changed":true,"attribution":"agent","thisTurn":true,"subagent":false,"sessions":["s"],"editedAt":5}]},
  "checks":{"headOid":"x","total":1,"passed":1,"failed":0,"pending":0,"current":false}}"#;

const DIFF: &str = r#"{"type":"diff","sessionId":null,"reviewId":"local-abc","requestId":"tui-1-5",
  "review":{"directory":"/w","source":"branch","revision":"r2","truncated":false,
    "head":"h","base":{"ref":"main","oid":"o","mergeBase":"m"},
    "files":[{"path":"a.rs","status":"M","patch":"@@ -1 +1 @@\n-a\n+b","additions":1,"deletions":1,"truncated":false}]}}"#;

const DELIVERED: &str = r#"{"type":"reviewDelivered","requestId":"tui-1-9","reviewId":"local-abc","sessionId":"s",
  "path":"operation","key":"k","bytes":42,
  "receipt":{"operationId":"op-1234567890","phase":"accepted","sessionId":"s"}}"#;

fn reply(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

#[test]
fn pull_review_opened_decodes_source_base_head_and_checks() {
    let opened = views::decode::<ReviewOpened>(&reply(PULL_OPENED)).unwrap();
    assert_eq!(opened.source.kind, ReviewSourceKind::Pull);
    assert_eq!(opened.source.owner.as_deref(), Some("o"));
    assert_eq!(opened.source.number, Some(5));
    assert_eq!(opened.source.title.as_deref(), Some("Fix the tree"));
    assert_eq!(opened.scope, OpenedScope::Branch);
    assert_eq!(opened.base.unwrap().name, "main");
    assert_eq!(opened.head.name.as_deref(), Some("topic"));
    assert_eq!(opened.checks.unwrap().pending, 1);
}

#[test]
fn review_sources_round_trip_the_fields_they_do_not_model() {
    for text in [PULL_OPENED, LOCAL_OPENED] {
        let event = reply(text);
        let opened = views::decode::<ReviewOpened>(&event).unwrap();
        assert_eq!(views::encode(&opened.source), event["source"]);
    }
    let local = views::decode::<ReviewOpened>(&reply(LOCAL_OPENED)).unwrap();
    assert_eq!(local.scope, OpenedScope::Unstaged);
    assert!(local.base.is_none());
    assert_eq!(local.source.session_id.as_deref(), Some("s"));
}

#[test]
fn review_context_decodes_readiness_provenance_and_checks() {
    let context = views::decode::<ReviewContext>(&reply(CONTEXT)).unwrap();
    assert_eq!(context.readiness.blockers, ["dirty", "unpushed"]);
    assert_eq!(context.readiness.base.unwrap().behind, 2);
    let provenance = context.provenance.unwrap();
    assert_eq!(provenance.evidence, "hooks");
    assert!(provenance.files[0].this_turn);
    assert_eq!(context.checks.unwrap().current, Some(false));
}

#[test]
fn diff_reply_keeps_routing_fields_when_its_review_is_unreadable() {
    let diff = views::decode::<DiffReply>(&reply(DIFF)).unwrap();
    assert_eq!(diff.review_id.as_deref(), Some("local-abc"));
    assert_eq!(diff.session_id, None);
    let review = diff.review.0.unwrap();
    assert_eq!(review.revision.as_deref(), Some("r2"));
    assert_eq!(review.files[0].additions, 1);

    let mut broken = reply(DIFF);
    broken["review"]["files"] = json!("nope");
    let diff = views::decode::<DiffReply>(&broken).unwrap();
    assert_eq!(diff.request_id.as_deref(), Some("tui-1-5"));
    assert!(diff.review.0.is_none());

    let failed = views::decode::<DiffReply>(
        &json!({"type":"diff","sessionId":"s","error":"A Git inspection is already running."}),
    )
    .unwrap();
    assert_eq!(failed.session_id.as_deref(), Some("s"));
    assert!(failed.error.is_some() && failed.review.0.is_none());
}

#[test]
fn delivery_and_progress_replies_decode_their_receipts() {
    let delivered = views::decode::<ReviewDelivered>(&reply(DELIVERED)).unwrap();
    assert_eq!(delivered.path, Some(DeliveryPath::Operation));
    assert_eq!(delivered.bytes, Some(42));
    assert_eq!(delivered.receipt.id, None);
    assert_eq!(
        delivered.receipt.operation_id.as_deref(),
        Some("op-1234567890")
    );
    let pasted = views::decode::<ReviewDelivered>(
        &json!({"path":"paste","bytes":3,"receipt":{"id":"r","phase":"pasted"}}),
    )
    .unwrap();
    assert_eq!(pasted.path, Some(DeliveryPath::Paste));
    let progress =
        views::decode::<ReviewProgress>(&json!({"type":"reviewProgress","stage":"fetch"})).unwrap();
    assert_eq!(progress.stage.as_deref(), Some("fetch"));
}

#[test]
fn review_requests_serialize_to_the_host_command_shapes() {
    assert_eq!(
        views::encode(&OpenReview {
            source: &ReviewSource::local("s")
        }),
        json!({"type":"openReview","source":{"kind":"local","sessionId":"s"}})
    );
    assert_eq!(
        views::encode(&OpenReview {
            source: &ReviewSource::pull("https://github.com/o/r/pull/5")
        }),
        json!({"type":"openReview","source":{"kind":"pull","url":"https://github.com/o/r/pull/5"}})
    );
    assert_eq!(
        views::encode(&ReviewDiffRequest {
            review_id: "local-abc",
            scope: "branch",
            base: None
        }),
        json!({"type":"getDiff","reviewId":"local-abc","scope":"branch"})
    );
    assert_eq!(
        views::encode(&SessionDiffRequest {
            session_id: "s",
            scope: "unstaged",
            directory: None
        }),
        json!({"type":"getDiff","sessionId":"s","scope":"unstaged","directory":null})
    );
    assert_eq!(
        views::encode(&ReviewContextRequest {
            review_id: "local-abc"
        }),
        json!({"type":"reviewContext","reviewId":"local-abc"})
    );
    assert_eq!(
        views::encode(&DeliverReview {
            review_id: "local-abc",
            session_id: "s",
            text: "t",
            lease_id: Some("l")
        }),
        json!({"type":"deliverReview","reviewId":"local-abc","sessionId":"s","text":"t","leaseId":"l"})
    );
    assert_eq!(
        views::encode(&WatchReviews {}),
        json!({"type":"watchReviews"})
    );
}
