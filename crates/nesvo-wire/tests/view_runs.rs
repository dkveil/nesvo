use nesvo_wire::views::{
    self,
    runs::{
        ControlKind, ControlRequest, DecisionPage, DecisionRequest, DecisionState, DependencyState,
        DigestReply, InboxPage, InboxRequest, RunCall, RunChanged, RunPage, RunView,
        TemplateRequest, WakeBatchPhase, WakeDelivery, WakeRequest, WakeState, WorkflowTemplates,
    },
};
use serde_json::{Value, json};

fn reply(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

const LIST: &str = r#"{"type":"workflow","requestId":"tui-7-runs-1","nextOffset":16,"runs":[
  {"id":"run-a","title":"Branch review","coordinatorSessionId":null,"revision":4,"state":"active","createdAt":2},
  {"id":"run-b","title":"Release notes","coordinatorSessionId":null,"revision":2,"state":"drained","createdAt":1}]}"#;

const VIEW: &str = r#"{"type":"workflow","requestId":"tui-7-runs-2",
  "run":{"id":"run-a","title":"Branch review","goal":"Review the branch","coordinatorSessionId":null,
    "revision":4,"state":"active","createdAt":2,"coordinatorBinding":null,"taskResult":null,
    "budget":{"limits":{"maxParallel":2,"maxAttemptsPerTask":3,"maxElapsedMs":null},"startedAt":null,
      "deadlineAt":null,"exhaustedAt":null,"timeState":"open","activeAttempts":1,"ownerDrain":false}},
  "tasks":[
    {"id":"t1","key":"implement","title":"Implement","instruction":"x","dependencies":[],"state":"reported",
     "dependencyState":"ready","attempts":2,"taskResult":null,
     "currentAttempt":{"id":"a2","ordinal":2,"sessionId":"s-worker","state":"reported","reportedOutcome":"succeeded"}},
    {"id":"t2","key":"review","title":"Review","instruction":"y","dependencies":["t1"],"state":"planned",
     "dependencyState":"waiting","attempts":0,"currentAttempt":null,"taskResult":null}]}"#;

const DECISIONS: &str = r#"{"type":"workflow","requestId":"tui-7-runs-3","nextOffset":null,
  "run":{"id":"run-a","title":"Branch review","revision":4,"state":"active"},"decisions":[
  {"id":"d1","runId":"run-a","taskId":"t1","attemptId":"a1","audience":"owner","question":"Old question",
   "revision":2,"state":"answered","askedBy":{"role":"coordinator","sessionId":"c"},"createdAt":1,"expiresAt":2,
   "answer":"no","reason":null,"resolvedAt":3,"resolvedBy":{"role":"owner"}},
  {"id":"d2","runId":"run-a","taskId":"t1","attemptId":"a2","audience":"owner","question":"Ship the migration now?",
   "revision":1,"state":"pending","askedBy":{"role":"owner"},"createdAt":1,"expiresAt":2,
   "answer":null,"reason":null,"resolvedAt":null,"resolvedBy":null}]}"#;

const INBOX: &str = r#"{"type":"workflow","pendingCount":3,"nextCursor":4,"headCursor":4,"more":false,
  "run":{"id":"run-a","title":"Branch review","revision":4,"state":"active"},
  "mailbox":{"runId":"run-a","recipientAttemptId":null},"messages":[
  {"id":"m1","runId":"run-a","createdAt":1,"sequence":1,"recipientAttemptId":null,"sender":{"role":"owner"},
   "correlationId":"c1","kind":"result","body":"Implementation reported","payload":null,"ackedAt":null,"ackedBy":null},
  {"id":"m2","kind":"decision","body":"Ship the migration now?"}]}"#;

const DIGEST: &str = r#"{"type":"workflow","run":{"id":"run-a","title":"Branch review","revision":4,"state":"active"},
  "stored":false,"fingerprint":"ffff","digest":{
  "schemaVersion":1,"kind":"workingState","runId":"run-a","title":"Branch review","state":"active","sourceRevision":4,
  "producedAt":9,"tasks":{"total":2,"byState":{"planned":1,"succeeded":1}},
  "taskDigests":[
    {"id":"t1","key":"implement","state":"succeeded","nextSteps":["Wire the parser into the CLI",7],
     "workspace":{"kind":"worktree","directory":"C:/w","branch":"nesvo/0123456789abcdef"}},
    {"id":"t2","key":"review","state":"planned","nextSteps":[],"workspace":null},
    "not a task"],
  "omittedTasks":0,"truncated":false,"decisions":{"answered":1,"closed":0,"pending":1,"total":2},
  "openDecisions":[],"budget":{"timeState":"open","activeAttempts":1},
  "inbox":{"pendingCoordinatorMessages":3,"messageHead":4},
  "evidence":{"journalCursor":41,"checkpointCount":2,"checkpoints":[]}}}"#;

const WAKES: &str = r#"{"type":"workflow","pendingCount":2,"deliveredThrough":11,"nextCursor":3,"more":false,"notices":[],
  "wakePolicy":{"id":"p","runId":"run-a","coordinator":"c","issuer":"i","enabled":true,"generation":2,
    "phase":"waiting","reason":"no_new_notices","createdAt":1,"delivery":"delta","held":false},
  "batches":[
    {"id":"b2aaaaaaaaaaaaaa","phase":"settled","reason":null,"createdAt":1,"delivery":"delta","noticeCount":8,"native":{"phase":"settled"}},
    {"id":"b1bbbbbbbbbbbbbb","phase":"unknown","reason":"host_restart","createdAt":1,"delivery":"full","noticeCount":3,"native":{"phase":"unknown"}}]}"#;

const TEMPLATES: &str = r#"{"type":"workflowTemplates","repository":"C:/Projects/nesvo","source":"HEAD:nesvo.toml",
  "configured":true,"digest":"aaaa","approved":true,"templates":[
  {"name":"review","title":"Branch review","goal":"g","start":"active","budget":null,
   "tasks":[{"key":"implement","program":"claude"},{"key":"review"}]},
  {"name":"triage","title":"Triage","goal":"g","start":"draft","budget":null,"tasks":[{"key":"triage"}]}]}"#;

#[test]
fn run_page_keeps_its_cursor_and_skips_a_malformed_run() {
    let page = views::decode::<RunPage>(&reply(LIST)).unwrap();
    assert_eq!(page.next_offset, Some(16));
    let runs: Vec<_> = page.runs.into_iter().filter_map(|run| run.0).collect();
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[1].state, "drained");
    assert_eq!(runs[0].goal, "");

    let mut broken = reply(LIST);
    broken["runs"][0]["revision"] = json!("four");
    broken["nextOffset"] = Value::Null;
    let page = views::decode::<RunPage>(&broken).unwrap();
    assert_eq!(page.next_offset, None);
    assert!(page.runs[0].0.is_none());
    assert_eq!(page.runs[1].0.as_ref().unwrap().id, "run-b");
}

#[test]
fn run_view_decodes_the_goal_tasks_and_current_attempt() {
    let view = views::decode::<RunView>(&reply(VIEW)).unwrap();
    let run = view.run.0.unwrap();
    assert_eq!(run.goal, "Review the branch");
    assert_eq!(run.revision, 4);
    let tasks: Vec<_> = view.tasks.into_iter().filter_map(|task| task.0).collect();
    assert_eq!(tasks[0].current_attempt.as_ref().unwrap().ordinal, 2);
    assert_eq!(tasks[0].dependency_state, DependencyState::Ready);
    assert_eq!(tasks[1].dependency_state, DependencyState::Waiting);
    assert!(tasks[1].current_attempt.is_none());

    let mut grown = reply(VIEW);
    grown["tasks"][1]["dependencyState"] = json!("blocked");
    grown["tasks"][0]["attempts"] = json!(-1);
    let view = views::decode::<RunView>(&grown).unwrap();
    assert!(view.tasks[0].0.is_none());
    assert_eq!(
        view.tasks[1].0.as_ref().unwrap().dependency_state,
        DependencyState::Unknown
    );
}

#[test]
fn decision_page_reads_states_and_tolerates_new_ones() {
    let mut event = reply(DECISIONS);
    let page = views::decode::<DecisionPage>(&event).unwrap();
    assert_eq!(page.next_offset, None);
    let states: Vec<_> = page
        .decisions
        .iter()
        .map(|decision| decision.0.as_ref().unwrap().state)
        .collect();
    assert_eq!(states, [DecisionState::Answered, DecisionState::Pending]);
    event["decisions"][0]["state"] = json!("superseded");
    let page = views::decode::<DecisionPage>(&event).unwrap();
    assert_eq!(
        page.decisions[0].0.as_ref().unwrap().state,
        DecisionState::Unknown
    );
}

#[test]
fn inbox_page_reads_the_pending_count_and_message_kinds() {
    let inbox = views::decode::<InboxPage>(&reply(INBOX)).unwrap();
    assert_eq!(inbox.pending_count, 3);
    let messages: Vec<_> = inbox.messages.into_iter().filter_map(|m| m.0).collect();
    assert_eq!(messages[0].kind, "result");
    assert_eq!(messages[1].body, "Ship the migration now?");
}

#[test]
fn digest_reads_counts_steps_and_branches_and_defaults_what_a_bounded_digest_drops() {
    let digest = views::decode::<DigestReply>(&reply(DIGEST)).unwrap().digest;
    assert_eq!(digest.kind, "workingState");
    assert_eq!(digest.source_revision, 4);
    assert_eq!(
        (digest.tasks.total, digest.tasks.by_state.succeeded),
        (2, 1)
    );
    assert_eq!(
        (digest.decisions.pending, digest.decisions.answered),
        (1, 1)
    );
    assert_eq!(digest.budget.time_state, "open");
    assert_eq!(digest.evidence.journal_cursor, 41);
    assert_eq!(digest.evidence.checkpoint_count, 2);
    assert!(digest.task_digests[2].0.is_none());
    let first = digest.task_digests[0].0.as_ref().unwrap();
    assert_eq!(first.key, "implement");
    assert_eq!(
        first.next_steps[0].0.as_deref(),
        Some("Wire the parser into the CLI")
    );
    assert!(first.next_steps[1].0.is_none());
    assert_eq!(
        first.workspace.as_ref().unwrap().branch.as_deref(),
        Some("nesvo/0123456789abcdef")
    );

    let mut bounded = reply(DIGEST);
    bounded["digest"]["budget"] = json!({});
    bounded["digest"]["tasks"] = json!({"total":2,"byState":{}});
    let digest = views::decode::<DigestReply>(&bounded).unwrap().digest;
    assert_eq!(digest.budget.time_state, "");
    assert_eq!(digest.tasks.by_state.succeeded, 0);
    assert_eq!(digest.tasks.total, 2);
}

#[test]
fn wake_state_reads_policy_batches_and_open_phases() {
    let mut event = reply(WAKES);
    let state = views::decode::<WakeState>(&event).unwrap();
    let policy = state.wake_policy.unwrap();
    assert!(policy.enabled && !policy.held);
    assert_eq!(policy.delivery, Some(WakeDelivery::Delta));
    assert_eq!((state.pending_count, state.delivered_through), (2, 11));
    let batches: Vec<_> = state.batches.into_iter().filter_map(|b| b.0).collect();
    assert_eq!(batches[0].phase, WakeBatchPhase::Settled);
    assert_eq!(batches[1].phase, WakeBatchPhase::Unknown);
    assert_eq!(batches[1].delivery, Some(WakeDelivery::Full));
    assert_eq!(batches[1].notice_count, 3);

    event["wakePolicy"] = Value::Null;
    event["batches"][0]["phase"] = json!("parked");
    let state = views::decode::<WakeState>(&event).unwrap();
    assert!(state.wake_policy.is_none());
    let phase = &state.batches[0].0.as_ref().unwrap().phase;
    assert_eq!(phase, &WakeBatchPhase::Other("parked".into()));
    assert_eq!(phase.as_str(), "parked");
}

#[test]
fn templates_and_started_runs_decode_what_the_template_page_shows() {
    let templates = views::decode::<WorkflowTemplates>(&reply(TEMPLATES)).unwrap();
    assert!(templates.approved);
    assert_eq!(templates.repository, "C:/Projects/nesvo");
    assert_eq!(templates.digest.as_deref(), Some("aaaa"));
    let items: Vec<_> = templates
        .templates
        .into_iter()
        .filter_map(|t| t.0)
        .collect();
    assert_eq!(items[0].tasks.len(), 2);
    assert_eq!(items[1].start, "draft");

    let started = views::decode::<RunChanged>(
        &json!({"type":"workflowTemplateStarted","run":{"id":"run-c","title":"Triage","revision":1}}),
    )
    .unwrap();
    assert_eq!(started.run.id.as_deref(), Some("run-c"));
    assert_eq!(started.run.title.as_deref(), Some("Triage"));
    assert_eq!(
        views::decode::<RunChanged>(&json!({"type":"workflow","decision":{"id":"d2"}}))
            .unwrap()
            .run
            .id,
        None
    );
}

#[test]
fn run_calls_encode_the_workflow_arguments_the_host_reads() {
    let encoded = |call: RunCall| (call.action(), views::encode(&call));
    assert_eq!(
        encoded(RunCall::List { offset: 0 }),
        ("list", json!({"offset":0}))
    );
    assert_eq!(
        encoded(RunCall::Digest { run_id: "r".into() }),
        ("digest", json!({"runId":"r"}))
    );
    assert_eq!(
        encoded(RunCall::Inbox {
            request: InboxRequest::Read { run_id: "r".into() }
        }),
        ("inbox", json!({"request":{"action":"read","runId":"r"}}))
    );
    assert_eq!(
        encoded(RunCall::Wakes {
            request: WakeRequest::Get {
                run_id: "r".into(),
                after: None
            }
        }),
        (
            "wakes",
            json!({"request":{"action":"get","runId":"r","after":null}})
        )
    );
    assert_eq!(
        encoded(RunCall::Wakes {
            request: WakeRequest::SetDelivery {
                key: "k".into(),
                run_id: "r".into(),
                expected_revision: 4,
                delivery: WakeDelivery::Full
            }
        })
        .1,
        json!({"request":{"action":"setDelivery","key":"k","runId":"r","expectedRevision":4,"delivery":"full"}})
    );
    assert_eq!(
        encoded(RunCall::Control {
            request: ControlRequest::Start {
                key: "k".into(),
                run_id: "r".into(),
                expected_revision: 4,
                kind: ControlKind::Stop
            }
        }),
        (
            "control",
            json!({"request":{"action":"start","key":"k","runId":"r","expectedRevision":4,"kind":"stop"}})
        )
    );
    assert_eq!(
        encoded(RunCall::Drain {
            key: "k".into(),
            run_id: "r".into(),
            expected_revision: 4
        }),
        ("drain", json!({"key":"k","runId":"r","expectedRevision":4}))
    );
    assert_eq!(
        encoded(RunCall::Decision {
            request: DecisionRequest::Answer {
                key: "k".into(),
                run_id: "r".into(),
                decision_id: "d".into(),
                expected_revision: 1,
                answer: "yes".into()
            }
        }),
        (
            "decision",
            json!({"request":{"action":"answer","key":"k","runId":"r","decisionId":"d","expectedRevision":1,"answer":"yes"}})
        )
    );
}

#[test]
fn template_requests_name_their_command_and_reply() {
    let start = TemplateRequest::StartWorkflowTemplate {
        directory: "C:/x",
        name: "review",
        key: "k",
    };
    assert_eq!(start.reply(), "workflowTemplateStarted");
    assert_eq!(
        views::encode(&start),
        json!({"type":"startWorkflowTemplate","directory":"C:/x","name":"review","key":"k"})
    );
    let approve = TemplateRequest::ApproveWorkflowTemplates {
        directory: "C:/x",
        digest: "d",
    };
    assert_eq!(approve.reply(), "workflowTemplatesApproved");
    assert_eq!(
        views::encode(&approve),
        json!({"type":"approveWorkflowTemplates","directory":"C:/x","digest":"d"})
    );
}
