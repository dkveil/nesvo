use super::*;
use crate::{
    agent_events::{Batch, Identity},
    launchers::Launchers,
    pty::{InputTraceEvent, InputTraceKind, InputTracePhase, PtyEvent},
    quota_contexts::Registry,
    status::{StatusState, StatusTracker},
    storage::MetadataStore,
    usage::{
        self, BucketCompleteness, BucketSource, CodexObservation, CodexSnapshot, ReadOutcome,
        ReaderContext, RouteObservation, RouteVerdict, WindowState,
    },
};
use std::{path::Path, sync::mpsc as sync_mpsc, time::Duration};
use tokio::sync::mpsc;

const REPORTS: [&str; 4] = [
    "state=blocked:kind=permission",
    "state=blocked:kind=question",
    "state=blocked:kind=auth",
    "state=working",
];

struct Fixture {
    state: OwnedState,
    id: String,
    arm: Arm,
    trace: sync_mpsc::Receiver<InputTraceEvent>,
    _output: mpsc::Receiver<PtyEvent>,
}

struct OwnedState(State);
impl std::ops::Deref for OwnedState {
    type Target = State;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for OwnedState {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl Drop for OwnedState {
    fn drop(&mut self) {
        for worker in self.0.shutdown() {
            let _ = worker.join();
        }
    }
}

fn observation(wall: u64, elapsed: u64, used: u8, reset: i64) -> CodexObservation {
    CodexObservation {
        started_at_ms: wall,
        finished_at_ms: wall,
        started_elapsed_ms: elapsed,
        finished_elapsed_ms: elapsed,
        context: Some(ReaderContext {
            codex_home: "private-native-queue-home".into(),
            context_id: "private-native-queue-context".into(),
            route: RouteObservation {
                verdict: RouteVerdict::ChatgptConfiguredOpenai,
                reason: "route_chatgpt_configured_openai",
                config_fingerprint: Some("private-native-queue-route".into()),
            },
        }),
        outcome: ReadOutcome::Snapshot(CodexSnapshot {
            account_id: Some("private-native-queue-account".into()),
            ordinary_usage_allowed: Some(true),
            windows: vec![
                usage::LimitWindow {
                    used_percent: used,
                    duration_mins: 300,
                    resets_at: Some(reset),
                },
                usage::LimitWindow {
                    used_percent: 20,
                    duration_mins: 10080,
                    resets_at: Some(reset + 86400),
                },
            ],
            complete: true,
            reason: "observed",
            bucket: BucketSource::NamedCodex,
            completeness: BucketCompleteness {
                primary: WindowState::Complete,
                secondary: WindowState::Complete,
            },
            spend_control_reached: Some(false),
            rate_limit_reached: false,
        }),
    }
}

fn confirm(answer: tokio::sync::oneshot::Receiver<bool>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
        .block_on(async {
            assert!(
                tokio::time::timeout(Duration::from_secs(2), answer)
                    .await
                    .expect("Owned PTY write must finish within two seconds")
                    .expect("Owned PTY confirmation channel must remain open")
            );
        });
}

impl Fixture {
    fn new() -> Self {
        let workspace = std::env::temp_dir().canonicalize().unwrap();
        let mut state = OwnedState(State::new(
            workspace.clone(),
            MetadataStore::open(Path::new(":memory:")).unwrap(),
            Launchers::discover_with_fixture_shell(),
        ));
        let (events, output) = mpsc::channel(128);
        let id = state
            .launch(
                &crate::jobs::LaunchSpec {
                    name: "Owned quota semantic native queue fixture".into(),
                    ..Default::default()
                },
                &events,
            )
            .unwrap();
        let binding = LaunchBinding::capture(
            (workspace.join("codex-fixture-metadata-only"), vec![]),
            workspace.clone(),
            workspace.join("codex-home-fixture-metadata-only"),
        )
        .unwrap();
        state.quota_contexts = Registry::new([93; 32]);
        let reader = state
            .quota_contexts
            .register(binding.reader_spec(), false)
            .unwrap();
        let first_elapsed = crate::event_log::monotonic_millis();
        let first_wall = crate::status::now_millis();
        let reset = (first_wall / 1000 + 1) as i64;
        assert_eq!(state.quota_contexts.next(first_elapsed).unwrap().id, reader);
        state
            .quota_contexts
            .finish(&reader, observation(first_wall, first_elapsed, 92, reset));
        let proof = binding
            .arm(
                &mut state.quota_contexts,
                &reader,
                first_wall,
                first_elapsed,
            )
            .unwrap();
        let next_start = first_elapsed + 5001;
        let wait = next_start.saturating_sub(crate::event_log::monotonic_millis());
        std::thread::sleep(Duration::from_millis(wait));
        let elapsed = crate::event_log::monotonic_millis();
        let wall = crate::status::now_millis();
        assert!(elapsed > proof.reset_elapsed_ms);
        state
            .quota_contexts
            .request(&reader, wall, elapsed)
            .unwrap();
        assert_eq!(state.quota_contexts.next(elapsed).unwrap().id, reader);
        state.quota_contexts.finish(
            &reader,
            observation(wall, elapsed, 20, (wall / 1000 + 3600) as i64),
        );
        assert!(matches!(
            binding.release(&mut state.quota_contexts, &proof, wall, elapsed),
            Release::Ready { .. }
        ));
        state.human_control_epoch = 41;
        let session = state.sessions.get_mut(&id).unwrap();
        session.info.program = Program::Codex;
        session.human_control_epoch = 41;
        session.quota_binding = Some(binding);
        session.conversation_identity = Some(identity(&id));
        let trace = session.pty.trace_input();
        confirm(session.pty.send_confirmed(String::new()).unwrap());
        let barrier = trace.try_iter().collect::<Vec<_>>();
        assert_eq!(barrier.len(), 3);
        assert!(barrier.iter().all(|event| event.bytes == 0));
        assert_eq!(barrier[2].written, Some(true));
        let arm = Arm {
            id: "a".repeat(32),
            session_id: id.clone(),
            launch_id: "owned-fixture-launch".into(),
            generation: 1,
            human_epoch: 41,
            predecessor_id: None,
            proof,
        };
        Self {
            state,
            id,
            arm,
            trace,
            _output: output,
        }
    }

    fn prepare(&mut self, index: usize) -> String {
        let session = self.state.sessions.get_mut(&self.id).unwrap();
        session.pending_input = None;
        session.quota_predecessor = None;
        session.human_input_dirty = false;
        session.status = StatusTracker::new(Program::Codex, 24, 80, 0);
        session
            .status
            .output(&draw("› "), crate::status::now_millis());
        session.status.refresh(crate::status::now_millis());
        assert!(session.status.quota_resume_editor(false));
        assert_eq!(session.status.status().state, StatusState::Blocked);
        session.wake_at = Some(self.arm.proof.reset_at);
        session.quota_wake = Some(self.arm.clone());
        assert_eq!(session.lifecycle_cursor, 0);
        assert_eq!(session.human_control_epoch, self.arm.human_epoch);
        assert!(session.controller.is_none());
        let error = self
            .state
            .check_submission(
                &self.id,
                crate::quota_wakes::PROMPT,
                &crate::caller::Authority::Owner,
            )
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<Error>().unwrap().code,
            "agent_not_ready"
        );
        let operation = format!("{index:032x}");
        let (_report, _cancellation) = self
            .state
            .begin_quota_submission(
                &self.arm,
                crate::submission::Claim {
                    id: operation.clone(),
                    issuer: "quota-wake".into(),
                    token: "owned-fixture-token".into(),
                },
                crate::quota_wakes::PROMPT,
            )
            .unwrap();
        assert!(
            self.state
                .guard_quota_submission(&self.id, &operation)
                .unwrap()
        );
        operation
    }

    fn program_report(&mut self, body: &str) {
        let session = self.state.sessions.get_mut(&self.id).unwrap();
        let before = session.status.semantic_revision();
        let lifecycle = session.lifecycle_cursor;
        let feed = session
            .terminal_protocol
            .feed(&format!("\x1b]7501;{body}\x1b\\"));
        assert!(feed.visible.is_empty());
        assert_eq!(feed.events.len(), 1);
        for event in feed.events {
            let crate::terminal_protocol::Event::Report(report) = event else {
                panic!("Expected one valid native root OSC report");
            };
            assert!(report.id.is_none());
            session.program_status.apply(report);
        }
        session
            .status
            .program_report(session.program_status.root(), crate::status::now_millis());
        session.status.refresh(crate::status::now_millis());
        assert!(session.status.semantic_revision() > before);
        assert_eq!(session.lifecycle_cursor, lifecycle);
        assert_eq!(session.human_control_epoch, self.arm.human_epoch);
        let current = session.conversation_identity.as_ref().unwrap();
        assert_eq!(current.launch_id, self.arm.launch_id);
        assert_eq!(current.generation, self.arm.generation);
        assert_eq!(
            current.provider_session_id.as_deref(),
            Some("owned-fixture-conversation")
        );
    }

    fn assert_rejected(&mut self, operation: &str, text: Option<&str>) {
        let error = self
            .state
            .enqueue_submission(&self.id, operation, text, Some(&batch(&self.id)))
            .expect_err("A newer semantic report must reject native queue admission");
        assert_eq!(
            error.downcast_ref::<Error>().unwrap().code,
            "agent_not_ready"
        );
        assert!(matches!(
            self.trace.try_recv(),
            Err(sync_mpsc::TryRecvError::Empty)
        ));
    }
}

fn identity(id: &str) -> Identity {
    Identity {
        host_session_id: id.into(),
        launch_id: "owned-fixture-launch".into(),
        provider_session_id: Some("owned-fixture-conversation".into()),
        generation: 1,
        rejected: 0,
        prompt_correlation: true,
    }
}
fn batch(id: &str) -> Batch {
    Batch {
        identity: identity(id),
        events: vec![],
        gap: false,
        observed: true,
        head_sequence: 0,
    }
}
fn draw(prompt: &str) -> String {
    format!("\x1b[?25h\x1b[2J\x1b[HYou've hit your usage limit. Try again later.\r\n{prompt}")
}

#[test]
fn newer_native_root_program_reports_reject_quota_paste_without_any_native_write() {
    let mut fixture = Fixture::new();
    for (index, report) in REPORTS.iter().enumerate() {
        let operation = fixture.prepare(index);
        fixture.program_report(report);
        fixture.assert_rejected(&operation, Some(crate::quota_wakes::PROMPT));
        assert!(
            !fixture.state.sessions[&fixture.id]
                .pending_input
                .as_ref()
                .unwrap()
                .queued
        );
    }
}

#[test]
fn newer_native_root_program_reports_after_confirmed_quota_paste_reject_enter() {
    let mut fixture = Fixture::new();
    for (index, report) in REPORTS.iter().enumerate() {
        let operation = fixture.prepare(index);
        let answer = fixture
            .state
            .enqueue_submission(
                &fixture.id,
                &operation,
                Some(crate::quota_wakes::PROMPT),
                Some(&batch(&fixture.id)),
            )
            .expect("Fresh matching quota/editor evidence must admit the one paste");
        confirm(answer);
        let paste = fixture.trace.try_iter().collect::<Vec<_>>();
        assert_eq!(paste.len(), 3);
        assert_eq!(paste[0].phase, InputTracePhase::Queued);
        assert_eq!(paste[2].phase, InputTracePhase::WriteFinished);
        assert!(
            paste
                .iter()
                .all(|event| event.kind == InputTraceKind::Receipt
                    && event.bytes == crate::quota_wakes::PROMPT.len())
        );
        assert_eq!(paste[2].written, Some(true));
        let session = fixture.state.sessions.get_mut(&fixture.id).unwrap();
        session.status.output(
            &draw("› Continue the previous task."),
            crate::status::now_millis(),
        );
        assert!(session.status.quota_resume_editor(true));
        fixture.program_report(report);
        fixture.assert_rejected(&operation, None);
        assert!(
            fixture.state.sessions[&fixture.id]
                .pending_input
                .as_ref()
                .unwrap()
                .queued
        );
        assert!(paste.iter().all(|event| event.bytes > 1));
    }
}
