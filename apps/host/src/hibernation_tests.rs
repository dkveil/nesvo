use super::super::{
    Client, ControlLease, Launchers, MetadataStore, PtyEvent, State, StatusTracker,
};
use crate::{
    agent_context::LifecycleReport,
    agent_events::Identity,
    caller::Authority,
    event_log::{Service, model::HibernationTrigger},
    hibernation::{self, IdlePolicy},
    jobs::LaunchSpec,
    launchers::Program,
    protocol::Command,
    resume::{Evidence, Gate, Start, Target},
    status::{StatusState, now_millis},
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, watch};

const CONVERSATION: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OWNER: HibernationTrigger = HibernationTrigger::Owner;

struct Fixture {
    directory: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "nesvo-hibernation-{}",
            hex::encode(nesvo_wire::random::<8>())
        ));
        std::fs::create_dir_all(&directory).unwrap();
        Self { directory }
    }

    fn database(&self) -> PathBuf {
        self.directory.join("metadata.sqlite3")
    }

    fn claude_launchers(&self) -> Launchers {
        let (fixture, _) = Launchers::discover_with_fixture_shell()
            .probe_command(Program::Shell)
            .unwrap();
        let providers = self.directory.join("providers");
        std::fs::create_dir_all(&providers).unwrap();
        std::fs::copy(
            fixture,
            providers.join(format!("claude{}", std::env::consts::EXE_SUFFIX)),
        )
        .unwrap();
        Launchers::locate(&[providers])
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn host(database: &Path) -> State {
    State::new(
        std::env::temp_dir().canonicalize().unwrap(),
        MetadataStore::open(database).unwrap(),
        Launchers::discover_with_fixture_shell(),
    )
}

fn owner(state: &mut State) -> mpsc::Receiver<Value> {
    let (events, receiver) = mpsc::channel(64);
    let (cancelled, _) = watch::channel(false);
    state.clients.insert(
        1,
        Client {
            events,
            cancelled,
            authority: Authority::Owner,
        },
    );
    receiver
}

fn drained() -> mpsc::Sender<PtyEvent> {
    let (events, mut output) = mpsc::channel(256);
    std::thread::spawn(move || while output.blocking_recv().is_some() {});
    events
}

fn launch(state: &mut State, events: &mpsc::Sender<PtyEvent>, parent: Option<&str>) -> String {
    state
        .launch(
            &LaunchSpec {
                name: "Hibernation fixture".into(),
                parent_session_id: parent.map(str::to_owned),
                ..Default::default()
            },
            events,
        )
        .unwrap()
}

fn agent(state: &mut State, id: &str, program: Program, idle_at: u64) {
    let session = state.sessions.get_mut(id).unwrap();
    session.info.program = program;
    session.status = StatusTracker::new(program, 24, 80, idle_at);
    assert!(session.status.lifecycle_ordered(
        LifecycleReport {
            state: StatusState::Idle,
            sequence: 1,
        },
        idle_at,
    ));
    session.status.refresh(idle_at);
    assert_eq!(session.status.status().state, StatusState::Idle);
    session.freshness.hook(idle_at);
    session.readiness = crate::readiness::Tracker::new(program);
    session
        .readiness
        .observe(session.status.status(), None, Duration::ZERO);
    session.conversation_identity = Some(Identity {
        host_session_id: id.into(),
        launch_id: "launch".into(),
        provider_session_id: Some(CONVERSATION.into()),
        generation: 1,
        rejected: 0,
        prompt_correlation: false,
    });
}

fn retire(state: &mut State, id: &str) {
    if let Some(mut session) = state.sessions.remove(id) {
        let _ = session.kill();
        state
            .cleanup_workers
            .push(std::thread::spawn(move || drop(session)));
    }
}

fn ready(state: &mut State, events: &mpsc::Sender<PtyEvent>) -> String {
    let id = launch(state, events, None);
    agent(state, &id, Program::Claude, now_millis());
    id
}

fn code(error: anyhow::Error) -> &'static str {
    hibernation::code(&error).unwrap_or("uncoded")
}

fn view(state: &State, id: &str) -> Option<Value> {
    state.list()["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|session| session["id"] == id)
        .cloned()
}

fn finish(state: &Arc<Mutex<State>>) {
    for worker in state.lock().unwrap().shutdown() {
        worker.join().unwrap();
    }
}

async fn kinds(log: &Service, id: &str) -> Vec<String> {
    log.read(0, 32, Some(id.to_owned()))
        .await
        .unwrap()
        .events
        .into_iter()
        .map(|event| event.kind)
        .collect()
}

async fn open(database: &Path) -> (Arc<Mutex<State>>, Service) {
    let mut state = host(database);
    let log = Service::open(database.to_path_buf()).await.unwrap();
    state.set_event_log(log.clone());
    (Arc::new(Mutex::new(state)), log)
}

#[test]
fn hibernation_refuses_every_ineligible_session_with_a_precise_code() {
    let fixture = Fixture::new();
    let mut state = host(&fixture.database());
    let events = drained();
    let attempt = |state: &mut State, id: &str| {
        state
            .prepare_hibernation(id, "key", OWNER)
            .map(|_| ())
            .map_err(code)
    };
    assert_eq!(
        attempt(&mut state, &"0".repeat(32)),
        Err("session_not_found")
    );
    let shell = launch(&mut state, &events, None);
    assert_eq!(attempt(&mut state, &shell), Err("hibernate_unsupported"));
    retire(&mut state, &shell);
    let gemini = launch(&mut state, &events, None);
    agent(&mut state, &gemini, Program::Gemini, now_millis());
    assert_eq!(attempt(&mut state, &gemini), Err("hibernate_unsupported"));
    retire(&mut state, &gemini);
    let codex = launch(&mut state, &events, None);
    agent(&mut state, &codex, Program::Codex, now_millis());
    assert_eq!(attempt(&mut state, &codex), Err("resume_unverifiable"));
    retire(&mut state, &codex);
    let anonymous = ready(&mut state, &events);
    state
        .sessions
        .get_mut(&anonymous)
        .unwrap()
        .conversation_identity = None;
    assert_eq!(attempt(&mut state, &anonymous), Err("resume_unavailable"));
    retire(&mut state, &anonymous);
    let pending = ready(&mut state, &events);
    state.sessions.get_mut(&pending).unwrap().resume = Some(Gate::new(Target {
        provider: Program::Claude,
        conversation_id: CONVERSATION.into(),
    }));
    assert_eq!(attempt(&mut state, &pending), Err("resume_pending"));
    retire(&mut state, &pending);
    let leased = ready(&mut state, &events);
    state.sessions.get_mut(&leased).unwrap().controller = Some(ControlLease {
        client_id: 7,
        id: "lease".into(),
        legacy: false,
    });
    assert_eq!(attempt(&mut state, &leased), Err("control_busy"));
    retire(&mut state, &leased);
    let drafted = ready(&mut state, &events);
    state.sessions.get_mut(&drafted).unwrap().human_input_dirty = true;
    assert_eq!(attempt(&mut state, &drafted), Err("unsafe_draft"));
    retire(&mut state, &drafted);
    let queued = ready(&mut state, &events);
    state.sessions.get_mut(&queued).unwrap().pending_input = Some(crate::submission::Pending {
        quota_resume: None,
        quota_sequence: None,
        quota_semantic_revision: None,
        authority: Authority::Owner,
        claim: crate::submission::Claim {
            id: "receipt".into(),
            issuer: "owner".into(),
            token: "token".into(),
        },
        canceled: watch::channel(false).0,
        correlation: None,
        digest: "digest".into(),
        source: None,
        queued: true,
        reconciliation_queued: false,
    });
    assert_eq!(attempt(&mut state, &queued), Err("submission_pending"));
    retire(&mut state, &queued);
    let working = ready(&mut state, &events);
    let session = state.sessions.get_mut(&working).unwrap();
    assert!(session.status.lifecycle_ordered(
        LifecycleReport {
            state: StatusState::Working,
            sequence: 2,
        },
        now_millis(),
    ));
    session.status.refresh(now_millis());
    assert_eq!(attempt(&mut state, &working), Err("agent_not_ready"));
    retire(&mut state, &working);
    let parent = ready(&mut state, &events);
    let child = launch(&mut state, &events, Some(&parent));
    assert_eq!(attempt(&mut state, &parent), Err("children_active"));
    retire(&mut state, &child);
    retire(&mut state, &parent);
    let woken = ready(&mut state, &events);
    state.sessions.get_mut(&woken).unwrap().wake_at = Some(1);
    assert_eq!(attempt(&mut state, &woken), Err("wake_armed"));
    retire(&mut state, &woken);
    let eligible = ready(&mut state, &events);
    assert_eq!(attempt(&mut state, &eligible), Ok(()));
    assert_eq!(attempt(&mut state, &eligible), Err("session_hibernating"));
    assert_eq!(
        state
            .check_submission(&eligible, "continue", &Authority::Owner)
            .map_err(code)
            .unwrap_err(),
        "session_hibernating"
    );
    state.sessions.get_mut(&eligible).unwrap().controller = Some(ControlLease {
        client_id: 7,
        id: "late".into(),
        legacy: false,
    });
    assert_eq!(
        state
            .complete_hibernation(&eligible, "key", OWNER)
            .map(|_| ())
            .map_err(code),
        Err("control_busy")
    );
    assert!(state.sessions[&eligible].info.running);
    assert!(state.sessions[&eligible].hibernating.is_none());
    for worker in state.shutdown() {
        worker.join().unwrap();
    }
}

#[tokio::test]
async fn hibernate_stops_the_process_keeps_the_record_and_replays_by_key() {
    let fixture = Fixture::new();
    let (state, log) = open(&fixture.database()).await;
    let (events, _output) = mpsc::channel(256);
    let (id, other) = {
        let mut guard = state.lock().unwrap();
        (ready(&mut guard, &events), ready(&mut guard, &events))
    };
    let reply = hibernation::hibernate(&state, &log, id.clone(), "k1".into(), OWNER)
        .await
        .unwrap();
    assert_eq!(reply["type"], "sessionHibernation");
    assert_eq!(reply["state"], "hibernated");
    assert_eq!(reply["replayed"], false);
    assert_eq!(reply["hibernation"]["conversationId"], CONVERSATION);
    {
        let guard = state.lock().unwrap();
        assert!(!guard.sessions.contains_key(&id));
        let listed = view(&guard, &id).unwrap();
        assert_eq!(listed["running"], false);
        assert_eq!(listed["hibernation"]["state"], "hibernated");
        assert_eq!(listed["hibernation"]["trigger"], "owner");
        assert_eq!(listed["status"]["freshness"]["lastKnown"]["state"], "idle");
        assert!(listed.get("lifecycle").is_none());
        let saved = guard.recovery_event(0).unwrap();
        assert!(
            saved["records"]
                .as_array()
                .unwrap()
                .iter()
                .all(|record| record["id"] != id.as_str())
        );
        assert!(
            guard
                .metadata
                .recoveries()
                .unwrap()
                .iter()
                .any(|r| r["id"] == id.as_str())
        );
        assert_eq!(
            code(
                guard
                    .check_submission(&id, "continue", &Authority::Owner)
                    .unwrap_err()
            ),
            "session_not_found"
        );
        assert_eq!(guard.capabilities_event()["hibernation"], true);
        assert_eq!(
            guard.capabilities_event()["hibernationIdlePolicy"],
            json!({"enabled":false,"idleAfterMs":null})
        );
    }
    let replayed = hibernation::hibernate(&state, &log, id.clone(), "k1".into(), OWNER)
        .await
        .unwrap();
    assert_eq!(replayed["replayed"], true);
    assert_eq!(replayed["hibernation"], reply["hibernation"]);
    assert_eq!(
        code(
            hibernation::hibernate(&state, &log, other.clone(), "k1".into(), OWNER)
                .await
                .unwrap_err()
        ),
        "idempotency_conflict"
    );
    assert_eq!(
        code(
            hibernation::hibernate(&state, &log, id.clone(), "k2".into(), OWNER)
                .await
                .unwrap_err()
        ),
        "session_hibernated"
    );
    assert_eq!(
        kinds(&log, &id)
            .await
            .iter()
            .filter(|kind| *kind == "session.hibernated")
            .count(),
        1
    );
    assert!(state.lock().unwrap().sessions[&other].info.running);
    finish(&state);
    log.shutdown().await;
}

struct Hibernated {
    state: Arc<Mutex<State>>,
    log: Service,
    id: String,
    events: mpsc::Sender<PtyEvent>,
    _output: mpsc::Receiver<PtyEvent>,
}

async fn hibernated(fixture: &Fixture) -> Hibernated {
    let (state, log) = open(&fixture.database()).await;
    let (events, output) = mpsc::channel(256);
    let id = ready(&mut state.lock().unwrap(), &events);
    hibernation::hibernate(&state, &log, id.clone(), "h".into(), OWNER)
        .await
        .unwrap();
    state.lock().unwrap().launchers = fixture.claude_launchers();
    Hibernated {
        state,
        log,
        id,
        events,
        _output: output,
    }
}

async fn answer(state: &Arc<Mutex<State>>, id: &str, conversation: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        {
            let mut guard = state.lock().unwrap();
            if let Some(gate) = guard
                .sessions
                .get_mut(id)
                .and_then(|session| session.resume.as_mut())
                .filter(|gate| gate.pending())
            {
                assert_eq!(gate.target().conversation_id, CONVERSATION);
                gate.observe(Evidence {
                    start: Some(&Start {
                        source: "resume".into(),
                        session_id: conversation.into(),
                    }),
                    bound: None,
                    running: true,
                    elapsed: Duration::ZERO,
                });
                return;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the relaunch never reached its resume gate"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn resume_relaunches_the_exact_conversation_under_the_same_session_id() {
    let fixture = Fixture::new();
    let Hibernated {
        state,
        log,
        id,
        events,
        _output,
    } = hibernated(&fixture).await;
    let resumed = tokio::spawn({
        let (state, log, events, id) = (state.clone(), log.clone(), events.clone(), id.clone());
        async move { hibernation::resume(&state, &log, &events, id, "r1".into()).await }
    });
    answer(&state, &id, CONVERSATION).await;
    let reply = resumed.await.unwrap().unwrap();
    assert_eq!(reply["state"], "resumed");
    assert_eq!(reply["resume"]["state"], "verified");
    assert_eq!(reply["resume"]["conversationId"], CONVERSATION);
    {
        let guard = state.lock().unwrap();
        assert!(guard.sessions.contains_key(&id));
        assert!(!guard.hibernated.contains(&id));
        assert!(view(&guard, &id).unwrap().get("hibernation").is_none());
        assert_eq!(guard.sessions[&id].info.program, Program::Claude);
    }
    let replayed = hibernation::resume(&state, &log, &events, id.clone(), "r1".into())
        .await
        .unwrap();
    assert_eq!(replayed["replayed"], true);
    let journal = kinds(&log, &id).await;
    let hibernated = journal.iter().position(|kind| kind == "session.hibernated");
    let resumed = journal.iter().position(|kind| kind == "session.resumed");
    assert!(
        hibernated.is_some() && resumed.is_some() && hibernated < resumed,
        "{journal:?}"
    );
    assert_eq!(
        code(
            hibernation::resume(&state, &log, &events, id.clone(), "r2".into())
                .await
                .unwrap_err()
        ),
        "session_not_hibernated"
    );
    finish(&state);
    log.shutdown().await;
}

#[tokio::test]
async fn resume_identity_mismatch_stops_the_relaunch_and_keeps_the_session_hibernated() {
    let fixture = Fixture::new();
    let Hibernated {
        state,
        log,
        id,
        events,
        _output,
    } = hibernated(&fixture).await;
    let resumed = tokio::spawn({
        let (state, log, events, id) = (state.clone(), log.clone(), events.clone(), id.clone());
        async move { hibernation::resume(&state, &log, &events, id, "r1".into()).await }
    });
    answer(&state, &id, OTHER).await;
    assert_eq!(
        code(resumed.await.unwrap().unwrap_err()),
        "resume_unverifiable"
    );
    {
        let guard = state.lock().unwrap();
        assert!(!guard.sessions.contains_key(&id));
        let listed = view(&guard, &id).unwrap();
        assert_eq!(listed["hibernation"]["state"], "hibernated");
        assert!(
            listed["hibernation"]["lastResumeFailure"]
                .as_str()
                .unwrap()
                .contains(OTHER)
        );
    }
    assert_eq!(
        code(
            hibernation::resume(&state, &log, &events, id.clone(), "r1".into())
                .await
                .unwrap_err()
        ),
        "resume_unverifiable"
    );
    assert!(
        !kinds(&log, &id)
            .await
            .iter()
            .any(|kind| kind == "session.resumed")
    );
    finish(&state);
    log.shutdown().await;
}

#[tokio::test]
async fn resume_refuses_an_unverifiable_provider_before_any_launch() {
    let fixture = Fixture::new();
    let Hibernated {
        state,
        log,
        id,
        events,
        _output,
    } = hibernated(&fixture).await;
    {
        let mut guard = state.lock().unwrap();
        let mut record = guard.hibernated.remove(&id).unwrap();
        record.spec.program = Program::Codex;
        record.spec.resume = Some(Target {
            provider: Program::Codex,
            conversation_id: CONVERSATION.into(),
        });
        guard.hibernated.insert(record);
    }
    assert_eq!(
        code(
            hibernation::resume(&state, &log, &events, id.clone(), "r1".into())
                .await
                .unwrap_err()
        ),
        "resume_unverifiable"
    );
    {
        let guard = state.lock().unwrap();
        assert!(guard.hibernated.contains(&id));
        assert!(!guard.sessions.contains_key(&id));
    }
    assert_eq!(
        code(
            hibernation::resume(&state, &log, &events, "0".repeat(32), "r2".into())
                .await
                .unwrap_err()
        ),
        "session_not_found"
    );
    finish(&state);
    log.shutdown().await;
}

#[tokio::test]
async fn hibernated_sessions_stay_hibernated_across_a_host_restart() {
    let fixture = Fixture::new();
    let database = fixture.database();
    let (state, log) = open(&database).await;
    let (events, _output) = mpsc::channel(256);
    let (kept, forgotten) = {
        let mut guard = state.lock().unwrap();
        (ready(&mut guard, &events), ready(&mut guard, &events))
    };
    for (id, key) in [(&kept, "a"), (&forgotten, "b")] {
        hibernation::hibernate(&state, &log, id.clone(), key.into(), OWNER)
            .await
            .unwrap();
    }
    {
        let mut guard = state.lock().unwrap();
        let mut receiver = owner(&mut guard);
        guard
            .command(
                1,
                Command::ForgetRecovery {
                    id: forgotten.clone(),
                },
                None,
                &events,
            )
            .unwrap();
        assert!(receiver.try_recv().is_ok());
        assert!(view(&guard, &forgotten).is_none());
    }
    finish(&state);
    log.shutdown().await;
    drop((state, log));
    let (state, log) = open(&database).await;
    hibernation::restore(&state, &log).await.unwrap();
    {
        let guard = state.lock().unwrap();
        let listed = view(&guard, &kept).unwrap();
        assert_eq!(listed["running"], false);
        assert_eq!(listed["hibernation"]["state"], "hibernated");
        assert!(view(&guard, &forgotten).is_none());
        assert_eq!(guard.hibernated.len(), 1);
    }
    let replayed = hibernation::hibernate(&state, &log, kept.clone(), "a".into(), OWNER)
        .await
        .unwrap();
    assert_eq!(replayed["replayed"], true);
    {
        let mut guard = state.lock().unwrap();
        let _receiver = owner(&mut guard);
        guard
            .command(
                1,
                Command::Close {
                    session_id: kept.clone(),
                },
                None,
                &events,
            )
            .unwrap();
        assert!(view(&guard, &kept).is_none());
        assert!(guard.metadata.recoveries().unwrap().is_empty());
    }
    finish(&state);
    log.shutdown().await;
}

#[tokio::test]
async fn resume_journals_no_second_session_created_and_restores_attention_from_the_record() {
    let fixture = Fixture::new();
    let (state, log) = open(&fixture.database()).await;
    let (events, _output) = mpsc::channel(256);
    let (id, revision) = {
        let mut guard = state.lock().unwrap();
        let id = ready(&mut guard, &events);
        let attention = &mut guard.sessions.get_mut(&id).unwrap().attention;
        assert!(attention.response_settled(5, "launch:4", 1_000));
        assert!(attention.project(Some("child"), 1));
        assert!(!attention.project(None, 0));
        let revision = attention.revision();
        (id, revision)
    };
    hibernation::hibernate(&state, &log, id.clone(), "h".into(), OWNER)
        .await
        .unwrap();
    state.lock().unwrap().launchers = fixture.claude_launchers();
    let resumed = tokio::spawn({
        let (state, log, events, id) = (state.clone(), log.clone(), events.clone(), id.clone());
        async move { hibernation::resume(&state, &log, &events, id, "r".into()).await }
    });
    answer(&state, &id, CONVERSATION).await;
    assert_eq!(resumed.await.unwrap().unwrap()["state"], "resumed");
    {
        let guard = state.lock().unwrap();
        let attention = &guard.sessions[&id].attention;
        let event = attention.event.as_ref().unwrap();
        assert_eq!(
            (event.subject, event.turn_id.as_deref(), event.unread),
            (Some("response"), Some("launch:4"), true)
        );
        assert_eq!(attention.revision(), revision);
        let item = guard
            .attention_sessions()
            .into_iter()
            .find(|item| item.session_id == id)
            .unwrap();
        assert_eq!((item.reason, item.revision), ("done", revision));
    }
    let journal = kinds(&log, &id).await;
    assert_eq!(
        journal
            .iter()
            .filter(|kind| *kind == "session.created")
            .count(),
        1,
        "{journal:?}"
    );
    assert!(journal.iter().any(|kind| kind == "session.resumed"));
    finish(&state);
    log.shutdown().await;
}

#[tokio::test]
async fn startup_reconciliation_removes_hibernation_rows_of_sessions_that_no_longer_exist() {
    let fixture = Fixture::new();
    let database = fixture.database();
    let (state, log) = open(&database).await;
    let (events, _output) = mpsc::channel(256);
    let (kept, closed) = {
        let mut guard = state.lock().unwrap();
        (ready(&mut guard, &events), ready(&mut guard, &events))
    };
    for (id, key) in [(&kept, "a"), (&closed, "b")] {
        hibernation::hibernate(&state, &log, id.clone(), key.into(), OWNER)
            .await
            .unwrap();
    }
    state
        .lock()
        .unwrap()
        .metadata
        .finish_recovery(&closed, true)
        .unwrap();
    finish(&state);
    log.shutdown().await;
    drop((state, log));
    let rows = || -> Vec<String> {
        let connection = rusqlite::Connection::open(&database).unwrap();
        let mut statement = connection
            .prepare("SELECT session_id FROM session_hibernations ORDER BY session_id")
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    assert_eq!(rows().len(), 2);
    let (state, log) = open(&database).await;
    hibernation::restore(&state, &log).await.unwrap();
    assert_eq!(rows(), [kept.clone()]);
    {
        let guard = state.lock().unwrap();
        assert!(view(&guard, &closed).is_none());
        assert_eq!(
            view(&guard, &kept).unwrap()["hibernation"]["state"],
            "hibernated"
        );
    }
    finish(&state);
    log.shutdown().await;
}

#[test]
fn idle_policy_is_off_by_default_and_selects_only_due_unwatched_eligible_agents() {
    let fixture = Fixture::new();
    let mut state = host(&fixture.database());
    let events = drained();
    let now = now_millis();
    let stale = now - 20 * 60_000;
    let quiet = launch(&mut state, &events, None);
    agent(&mut state, &quiet, Program::Claude, stale);
    let watched = launch(&mut state, &events, None);
    agent(&mut state, &watched, Program::Claude, stale);
    state
        .sessions
        .get_mut(&watched)
        .unwrap()
        .subscribers
        .insert(9);
    let recent = launch(&mut state, &events, None);
    agent(&mut state, &recent, Program::Claude, now);
    assert!(state.idle_hibernation_candidates(now).is_empty());
    state.set_hibernation_idle_policy(IdlePolicy::from_minutes(Some(15)).unwrap());
    assert_eq!(
        state.capabilities_event()["hibernationIdlePolicy"],
        json!({"enabled":true,"idleAfterMs":900_000})
    );
    assert_eq!(
        state.idle_hibernation_candidates(now),
        [(quiet.clone(), stale)]
    );
    for worker in state.shutdown() {
        worker.join().unwrap();
    }
}
