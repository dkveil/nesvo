use nesvo_wire::views::{
    self, HostError, ReplyHeader,
    jobs::{
        CalendarState, JobPage, JobReply, JobRequest, JobScheduleKind, JobSpec, JobWorkspace,
        JobsCall, Keyed, Overlap, QuotaState,
    },
};
use serde_json::{Value, json};

const DETAIL: &str = r#"{"type":"workflow","requestId":"tui-7-jobs-2","job":{
  "id":"daily","title":"Daily review","revision":3,"enabled":true,"nextDueAt":1792591320000,
  "createdAt":1,"schedule":{"kind":"once","at":"2026-10-21T16:02:00+02:00"},
  "calendarState":"ready","calendarError":null,
  "spec":{"title":"Daily review","instruction":"Review changes and report findings.",
    "profile":{"name":null,"cwd":"C:/Projects/nesvo","program":"codex","workspace":"shared","harness":true,"model":"gpt-5"},
    "schedule":{"kind":"once","at":"2026-10-21T16:02:00+02:00"},
    "precheckId":"precheck-1",
    "retry":{"on":"launchNoEffect","maxAttempts":2,"initialDelayMs":1000,"maxDelayMs":1000},
    "executionTimeoutMs":120000,
    "quotaPolicy":{"mode":"wait","contextId":"ctx","accountFingerprint":"fp"},
    "misfire":"catchUp","graceMs":60000,"overlap":"queue","maxElapsedMs":300000}}}"#;

const PAGE: &str = r#"{"type":"workflow","requestId":"tui-7-jobs-1","nextOffset":16,"jobs":[
  {"id":"nightly","title":"Nightly checks","revision":1,"enabled":true,"nextDueAt":null,"createdAt":2,
   "schedule":{"kind":"cron","expression":"0 2 * * *","timeZone":"Europe/Warsaw"},
   "calendarState":"blocked","calendarError":{"code":"calendar_failed","message":"bad"}},
  {"id":"watch","title":"Dependency watch","revision":1,"enabled":false,"nextDueAt":null,"createdAt":3,
   "schedule":{"kind":"external"},"calendarState":"exhausted","calendarError":null}]}"#;

const OCCURRENCE: &str = r#"{"type":"workflow","requestId":"tui-7-jobs-3","occurrence":{
  "id":"o1","jobId":"daily","jobRevision":3,"trigger":"schedule","dueAt":10,"createdAt":9,
  "state":"retryWaiting","reason":"quota_wait","runId":null,"startedAt":null,"finishedAt":null,
  "coalescedFromAt":null,"precheck":null,"cancellation":null,"executionTimeout":null,
  "quota":{"state":"waiting","reason":"source_unavailable","contextId":"ctx","accountFingerprint":"fp","sourceRevision":null},
  "launchReconciliation":null,"launchResolution":null,"jobAttemptId":null,"jobAttemptOrdinal":null,
  "retry":null,"attemptId":null,"sessionId":null,"launchReceiptId":null}}"#;

fn reply(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

#[test]
fn job_detail_decodes_every_field_the_tui_reads() {
    let event = reply(DETAIL);
    assert_eq!(
        ReplyHeader::of(&event).request_id.as_deref(),
        Some("tui-7-jobs-2")
    );
    let job = views::decode::<JobReply>(&event).unwrap().job.unwrap();
    assert_eq!(job.revision, 3);
    assert_eq!(job.schedule.kind, JobScheduleKind::Once);
    assert_eq!(job.calendar_state, Some(CalendarState::Ready));
    let spec = job.spec.unwrap();
    assert_eq!(spec.profile.program.as_deref(), Some("codex"));
    assert_eq!(spec.profile.workspace, Some(JobWorkspace::Shared));
    assert_eq!(spec.overlap, Some(Overlap::Queue));
    assert_eq!(spec.retry.unwrap().max_attempts, Some(2));
    assert_eq!(spec.execution_timeout_ms, Some(120_000));
    assert!(spec.quota_policy.is_some());
}

#[test]
fn job_spec_round_trips_fields_the_tui_does_not_show() {
    let event = reply(DETAIL);
    let spec: JobSpec = serde_json::from_value(event["job"]["spec"].clone()).unwrap();
    assert_eq!(views::encode(&spec), event["job"]["spec"]);
}

#[test]
fn job_page_keeps_open_kinds_and_states_and_its_cursor() {
    let page = views::decode::<JobPage>(&reply(PAGE)).unwrap();
    assert_eq!(page.next_offset, Some(16));
    assert_eq!(page.jobs[0].calendar_state, Some(CalendarState::Blocked));
    assert_eq!(page.jobs[1].schedule.kind, JobScheduleKind::External);
    assert!(page.jobs.iter().all(|job| job.spec.is_none()));

    let mut grown = reply(PAGE);
    grown["jobs"][0]["schedule"] = json!({"kind":"interval","everyMs":60000});
    grown["jobs"][1]["calendarState"] = json!("drifting");
    let page = views::decode::<JobPage>(&grown).unwrap();
    assert_eq!(
        page.jobs[0].schedule.kind,
        JobScheduleKind::Other("interval".into())
    );
    assert_eq!(page.jobs[1].calendar_state, Some(CalendarState::Unknown));
    assert_eq!(
        views::encode(&page.jobs[0].schedule),
        grown["jobs"][0]["schedule"]
    );
}

#[test]
fn a_malformed_job_drops_its_page_but_keeps_the_cursor() {
    let mut broken = reply(PAGE);
    broken["jobs"][1]["revision"] = json!("three");
    let page = views::decode::<JobPage>(&broken).unwrap();
    assert!(page.jobs.is_empty());
    assert_eq!(page.next_offset, Some(16));
}

#[test]
fn occurrence_decodes_quota_and_tolerates_unknown_quota_states() {
    let mut event = reply(OCCURRENCE);
    let occurrence = views::decode::<JobReply>(&event)
        .unwrap()
        .occurrence
        .unwrap();
    assert_eq!(occurrence.state, "retryWaiting");
    assert_eq!(occurrence.quota.state, Some(QuotaState::Waiting));
    assert_eq!(
        occurrence.quota.reason.as_deref(),
        Some("source_unavailable")
    );
    event["occurrence"]["quota"] = json!({"state":"paused","resetsAt":"later"});
    let occurrence = views::decode::<JobReply>(&event)
        .unwrap()
        .occurrence
        .unwrap();
    assert_eq!(occurrence.quota.state, Some(QuotaState::Unknown));
    assert_eq!(occurrence.quota.resets_at, None);
    event["occurrence"]["quota"] = Value::Null;
    let occurrence = views::decode::<JobReply>(&event)
        .unwrap()
        .occurrence
        .unwrap();
    assert_eq!(occurrence.quota.state, None);
}

#[test]
fn job_requests_serialize_to_the_host_request_shapes() {
    let list = views::encode(&JobsCall {
        request: JobRequest::List { offset: 16 },
    });
    assert_eq!(list, json!({"request":{"action":"list","offset":16}}));
    let request = JobRequest::SetEnabled {
        job_id: "daily".into(),
        expected_revision: 3,
        enabled: false,
    };
    let keyed = views::encode(&JobsCall {
        request: Keyed {
            key: "tui-job-1",
            request: &request,
        },
    });
    assert_eq!(
        keyed,
        json!({"request":{"action":"setEnabled","key":"tui-job-1","jobId":"daily","expectedRevision":3,"enabled":false}})
    );
    let cancel = views::encode(&JobRequest::CancelOccurrence {
        job_id: "daily".into(),
        occurrence_id: "o1".into(),
    });
    assert_eq!(
        cancel,
        json!({"action":"cancelOccurrence","jobId":"daily","occurrenceId":"o1"})
    );
}

#[test]
fn host_errors_decode_with_missing_or_odd_fields() {
    let error = HostError::of(
        &json!({"type":"error","requestId":"r","code":"revision_conflict","message":"stale"}),
    );
    assert_eq!(error.request_id.as_deref(), Some("r"));
    assert_eq!(error.code(), "revision_conflict");
    let odd = HostError::of(&json!({"type":"error","requestId":7,"message":null}));
    assert_eq!(odd.request_id, None);
    assert_eq!(odd.code(), "");
    assert_eq!(odd.message_or("fallback"), "fallback");
}
