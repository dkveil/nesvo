use super::*;
use crate::usage::parse_claude_observation;

const RECORDED_CACHE: &str = r#"{"at":1792613681,"rate_limits":{"five_hour":{"used_percentage":18,"resets_at":1792629000},"seven_day":{"used_percentage":32,"resets_at":1792954800}}}"#;
const SYNTHESIZED_EXHAUSTED_CACHE: &str = r#"{"at":1792613681,"rate_limits":{"five_hour":{"used_percentage":100,"resets_at":1792629000},"seven_day":{"used_percentage":64,"resets_at":1792954800}}}"#;
const SYNTHESIZED_ACCOUNT_FILE: &str = r#"{"numStartups":3,"oauthAccount":{"accountUuid":"00000000-0000-4000-8000-000000000001","organizationUuid":"00000000-0000-4000-8000-000000000002","emailAddress":"owner@example.invalid"}}"#;
const RECORDED_CONFIG_DIR_SHAPE: &str = r#"{"firstStartTime":"2026-10-12T20:45:00.000Z","machineID":"synthesized","userID":"synthesized","migrationVersion":3}"#;
const SOURCE_AT_MS: u64 = 1_792_613_681_000;
const FIVE_HOUR_RESET_MS: u64 = 1_792_629_000_000;
const ELAPSED: u64 = 50_000;

fn cache(raw: &str, observed_at_ms: u64) -> ClaudeObservation {
    parse_claude_observation(&serde_json::from_str(raw).unwrap(), observed_at_ms)
}

fn gate() -> Gate {
    let mut gate = Gate::new([7; 32], &[Program::Claude, Program::Codex, Program::Gemini]);
    gate.register(Program::Claude, "claudeStatusline", 0);
    gate.register(Program::Codex, "codexAppServer", 0);
    gate
}

fn account(gate: &Gate) -> Option<String> {
    let value = serde_json::from_str(SYNTHESIZED_ACCOUNT_FILE).unwrap();
    claude_account_identity(&value).map(|(id, org)| gate.fingerprint(&[&id, &org]))
}

fn claude(gate: &mut Gate, raw: &str, age_ms: u64, revision: u64) -> bool {
    let fingerprint = account(gate);
    let admission = claude_admission(
        &cache(raw, SOURCE_AT_MS + age_ms),
        fingerprint,
        revision,
        ELAPSED,
    );
    gate.observe(Program::Claude, admission, ELAPSED)
}

fn codex_view(revision: u64, freshness: &'static str, reason: &'static str, used: u8) -> View {
    View {
        program: Program::Codex,
        source: "codexAppServer",
        revision,
        status: if freshness == "fresh" {
            "ready"
        } else {
            "unavailable"
        },
        reason: if freshness == "fresh" {
            "observed"
        } else {
            reason
        },
        attempted_at: Some(SOURCE_AT_MS),
        observed_at: Some(SOURCE_AT_MS),
        source_at: None,
        expires_at: Some(SOURCE_AT_MS + 180_000),
        expires_elapsed_ms: (freshness == "fresh").then_some(ELAPSED + 180_000),
        age_ms: Some(0),
        freshness,
        complete: true,
        ordinary_usage_allowed: Some(used < 100),
        windows: vec![
            LimitWindow {
                used_percent: used,
                duration_mins: 300,
                resets_at: Some((FIVE_HOUR_RESET_MS / 1000) as i64),
            },
            LimitWindow {
                used_percent: 10,
                duration_mins: 10080,
                resets_at: Some(1_792_954_800),
            },
        ],
        context_id: Some("c".repeat(64)),
        account_fingerprint: Some("a".repeat(64)),
        ordinary_usage_eligible: freshness == "fresh" && used < 100,
        eligibility_reason: if freshness != "fresh" {
            reason
        } else if used >= 100 {
            "quota_exhausted"
        } else {
            "observed"
        },
        scope: "readerSnapshotOnly",
    }
}

#[test]
fn recorded_statusline_capture_is_admission_grade_only_while_fresh_with_an_account() {
    let mut gate = gate();
    assert!(claude(&mut gate, RECORDED_CACHE, 4_000, 1));
    assert_eq!(
        gate.verdict(Program::Claude, SOURCE_AT_MS + 4_000, ELAPSED + 1),
        Verdict::Allow
    );
    assert_eq!(
        gate.verdict(Program::Claude, SOURCE_AT_MS + 20_000, ELAPSED + 21_001),
        Verdict::Unknown {
            reason: "observation_expired"
        }
    );
    assert!(claude(&mut gate, RECORDED_CACHE, 20_000, 2));
    assert_eq!(
        gate.verdict(Program::Claude, SOURCE_AT_MS + 20_000, ELAPSED + 1),
        Verdict::Unknown {
            reason: "source_stale"
        }
    );
    let anonymous = claude_admission(
        &cache(RECORDED_CACHE, SOURCE_AT_MS + 1_000),
        None,
        3,
        ELAPSED,
    );
    assert_eq!(anonymous.reason, "account_unavailable");
    assert_eq!(anonymous.fresh_until_elapsed_ms, None);
    let future = claude_admission(
        &cache(RECORDED_CACHE, SOURCE_AT_MS - 10_000),
        account(&gate),
        4,
        ELAPSED,
    );
    assert_eq!(future.fresh_until_elapsed_ms, None);
}

#[test]
fn an_admission_grade_reading_stays_fresh_until_the_next_scheduled_read_can_land() {
    let mut gate = gate();
    assert!(claude(
        &mut gate,
        RECORDED_CACHE,
        CLAUDE_FRESHNESS_MS - 1,
        1
    ));
    let next_read = ELAPSED + CLAUDE_READ_INTERVAL_MS;
    let landed = next_read + CLAUDE_READ_BOUND_MS;
    for elapsed in [ELAPSED + 1, next_read - 1, next_read, landed - 1] {
        assert_eq!(
            gate.verdict(Program::Claude, SOURCE_AT_MS + 20_000, elapsed),
            Verdict::Allow,
            "{elapsed}"
        );
    }
    assert_eq!(
        gate.verdict(Program::Claude, SOURCE_AT_MS + 40_000, landed),
        Verdict::Unknown {
            reason: "observation_expired"
        }
    );
    let refreshed = claude_admission(
        &cache(RECORDED_CACHE, SOURCE_AT_MS + 2_000),
        account(&gate),
        2,
        next_read,
    );
    assert!(gate.observe(
        Program::Claude,
        refreshed,
        next_read + CLAUDE_READ_BOUND_MS - 1
    ));
    assert_eq!(
        gate.verdict(Program::Claude, SOURCE_AT_MS + 40_000, landed),
        Verdict::Allow
    );
}

#[test]
fn account_fingerprint_reads_only_the_oauth_identity_and_never_publishes_it() {
    let gate = gate();
    let value = serde_json::from_str(SYNTHESIZED_ACCOUNT_FILE).unwrap();
    let (id, org) = claude_account_identity(&value).unwrap();
    let fingerprint = gate.fingerprint(&[&id, &org]);
    assert_eq!(fingerprint.len(), 64);
    assert!(!fingerprint.contains(&id));
    assert_ne!(
        fingerprint,
        Gate::new([8; 32], &[]).fingerprint(&[&id, &org])
    );
    assert!(
        claude_account_identity(&serde_json::from_str(RECORDED_CONFIG_DIR_SHAPE).unwrap())
            .is_none()
    );
    assert!(
        claude_account_identity(&serde_json::json!({"oauthAccount":{"accountUuid":"bad id\n"}}))
            .is_none()
    );
}

#[tokio::test]
async fn account_reader_skips_missing_and_non_regular_paths() {
    let directory = std::env::temp_dir().join(format!(
        "nesvo-quota-gate-{}",
        hex::encode(crate::wire::random::<8>())
    ));
    std::fs::create_dir(&directory).unwrap();
    let file = directory.join(".claude.json");
    std::fs::write(&file, SYNTHESIZED_ACCOUNT_FILE).unwrap();
    let found =
        read_claude_account(&[directory.join("missing.json"), directory.clone(), file]).await;
    assert_eq!(
        found.map(|(id, _)| id).as_deref(),
        Some("00000000-0000-4000-8000-000000000001")
    );
    std::fs::remove_dir_all(&directory).unwrap();
}

#[test]
fn synthesized_exhausted_window_holds_until_reset_and_a_newer_read_releases_it() {
    let mut gate = gate();
    assert!(claude(&mut gate, SYNTHESIZED_EXHAUSTED_CACHE, 1_000, 1));
    let held = Verdict::Hold {
        reason: "quota_exhausted",
        resets_at_ms: Some(FIVE_HOUR_RESET_MS),
    };
    assert_eq!(
        gate.verdict(Program::Claude, SOURCE_AT_MS + 1_000, ELAPSED),
        held
    );
    assert_eq!(
        gate.verdict(Program::Claude, SOURCE_AT_MS + 600_000, ELAPSED + 600_000),
        held,
        "staleness alone never releases a known limit"
    );
    assert!(claude(&mut gate, RECORDED_CACHE, 30_000, 2));
    assert_eq!(
        gate.verdict(Program::Claude, SOURCE_AT_MS + 30_000, ELAPSED),
        held,
        "a stale newer read cannot release it"
    );
    assert_eq!(
        gate.verdict(Program::Claude, FIVE_HOUR_RESET_MS + 1, ELAPSED + 1),
        Verdict::Unknown {
            reason: "window_reset_elapsed"
        }
    );
    assert!(claude(&mut gate, RECORDED_CACHE, 2_000, 3));
    assert_eq!(
        gate.verdict(Program::Claude, SOURCE_AT_MS + 2_000, ELAPSED),
        Verdict::Allow
    );
    assert!(!claude(&mut gate, SYNTHESIZED_EXHAUSTED_CACHE, 1_000, 3));
}

#[test]
fn codex_limit_holds_while_a_network_failure_stays_unknown() {
    let mut gate = gate();
    observe_codex_view(&mut gate, &codex_view(1, "unavailable", "read_failed", 0));
    assert_eq!(
        gate.verdict(Program::Codex, SOURCE_AT_MS, ELAPSED),
        Verdict::Unknown {
            reason: "read_failed"
        }
    );
    observe_codex_view(&mut gate, &codex_view(2, "fresh", "observed", 100));
    let held = gate.verdict(Program::Codex, SOURCE_AT_MS, ELAPSED);
    assert_eq!(
        held,
        Verdict::Hold {
            reason: "quota_exhausted",
            resets_at_ms: Some(FIVE_HOUR_RESET_MS)
        }
    );
    observe_codex_view(&mut gate, &codex_view(3, "unavailable", "read_failed", 0));
    assert_eq!(gate.verdict(Program::Codex, SOURCE_AT_MS, ELAPSED), held);
    observe_codex_view(&mut gate, &codex_view(4, "fresh", "observed", 40));
    assert_eq!(
        gate.verdict(Program::Codex, SOURCE_AT_MS, ELAPSED),
        Verdict::Allow
    );
    observe_codex_view(
        &mut gate,
        &codex_view(0, "unavailable", "awaiting_observation", 0),
    );
    assert_eq!(
        gate.verdict(Program::Codex, SOURCE_AT_MS, ELAPSED),
        Verdict::Allow
    );
}

#[test]
fn providers_without_a_source_are_unknown_and_first_reads_are_bounded() {
    let gate = gate();
    assert_eq!(
        gate.verdict(Program::Gemini, SOURCE_AT_MS, ELAPSED),
        Verdict::Unknown {
            reason: "no_admission_source"
        }
    );
    assert_eq!(
        gate.verdict(Program::Shell, SOURCE_AT_MS, ELAPSED),
        Verdict::Allow
    );
    assert_eq!(
        gate.verdict(Program::Claude, SOURCE_AT_MS, 29_999),
        Verdict::Hold {
            reason: "awaiting_observation",
            resets_at_ms: None
        }
    );
    assert_eq!(
        gate.wake_after_ms(Program::Claude, SOURCE_AT_MS, 29_000),
        Some(1_000)
    );
    assert_eq!(
        gate.verdict(Program::Claude, SOURCE_AT_MS, 30_000),
        Verdict::Unknown {
            reason: "source_unavailable"
        }
    );
    let view = gate.view(SOURCE_AT_MS, 30_000);
    let gemini = view["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["program"] == "gemini")
        .unwrap();
    assert_eq!(gemini["source"], "unsupported");
    assert_eq!(gemini["verdict"], "unknown");
    assert_eq!(gemini["reason"], "no_admission_source");
}

#[test]
fn publications_follow_hold_changes_only() {
    let mut gate = Gate::new([7; 32], &[Program::Claude, Program::Codex]);
    gate.register(Program::Claude, "claudeStatusline", ELAPSED);
    gate.register(Program::Codex, "codexAppServer", ELAPSED);
    let first = gate.tick(SOURCE_AT_MS, ELAPSED);
    assert_eq!(first.len(), 2);
    assert!(first.iter().all(|o| !o.eligible
        && o.reason == "awaiting_observation"
        && o.expires_elapsed_ms == UNTIMED_EXPIRY
        && o.binding.is_none()));
    assert!(gate.tick(SOURCE_AT_MS, ELAPSED + 10).is_empty());
    claude(&mut gate, SYNTHESIZED_EXHAUSTED_CACHE, 1_000, 1);
    let held = gate.tick(SOURCE_AT_MS + 1_000, ELAPSED);
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].source_id, "gate_claude");
    assert_eq!(held[0].reason, "quota_exhausted");
    assert_eq!(
        held[0].expires_elapsed_ms,
        ELAPSED + FIVE_HOUR_RESET_MS - SOURCE_AT_MS - 1_000
    );
    assert!(
        gate.tick(SOURCE_AT_MS + 21_000, ELAPSED + 20_000)
            .is_empty()
    );
    claude(&mut gate, RECORDED_CACHE, 1_000, 2);
    let released = gate.tick(SOURCE_AT_MS + 1_000, ELAPSED);
    assert_eq!(released.len(), 1);
    assert!(released[0].eligible);
    assert!(released[0].revision > held[0].revision);
}

#[test]
fn hold_queue_is_bounded_and_unverified_marks_are_retained_per_session() {
    let mut gate = gate();
    for index in 0..QUEUE_CAPACITY {
        gate.enqueue(Held {
            id: format!("launch-{index}"),
            kind: "launch",
            program: Program::Claude,
            reason: "quota_exhausted",
            resets_at_ms: Some(FIVE_HOUR_RESET_MS),
            since_ms: SOURCE_AT_MS,
            checks: 1,
        })
        .unwrap();
    }
    let full = gate.enqueue(Held {
        id: "overflow".into(),
        kind: "operation",
        program: Program::Claude,
        reason: "quota_exhausted",
        resets_at_ms: None,
        since_ms: SOURCE_AT_MS,
        checks: 1,
    });
    assert_eq!(
        full.unwrap_err().downcast_ref::<Error>().unwrap().code,
        "busy"
    );
    gate.dequeue("launch-0");
    assert_eq!(gate.queue.len(), QUEUE_CAPACITY - 1);
    gate.mark_unverified("session", "source_stale");
    assert_eq!(gate.unverified("session")["reason"], "source_stale");
    assert!(gate.unverified("other").is_null());
}

fn host() -> Arc<Mutex<State>> {
    Arc::new(Mutex::new(State::new(
        std::env::temp_dir(),
        crate::storage::MetadataStore::open(Path::new(":memory:")).unwrap(),
        crate::launchers::Launchers::discover(),
    )))
}

fn hold_now(state: &Arc<Mutex<State>>, program: Program) {
    let now = crate::status::now_millis();
    let elapsed = crate::event_log::monotonic_millis();
    let mut state = state.lock().unwrap();
    state
        .quota_gate
        .register(program, "claudeStatusline", elapsed);
    state.quota_gate.observe(
        program,
        Admission {
            revision: 1,
            fresh_until_elapsed_ms: Some(elapsed + 60_000),
            account: Some("a".repeat(64)),
            limit: Some(Limit {
                reason: "quota_exhausted",
                resets_at_ms: Some(now + 5 * 3_600_000),
            }),
            reason: "quota_exhausted",
        },
        elapsed,
    );
}

fn release_now(state: &Arc<Mutex<State>>, program: Program) {
    let elapsed = crate::event_log::monotonic_millis();
    state.lock().unwrap().quota_gate.observe(
        program,
        Admission {
            revision: 2,
            fresh_until_elapsed_ms: Some(elapsed + 60_000),
            account: Some("a".repeat(64)),
            limit: None,
            reason: "observed",
        },
        elapsed,
    );
}

#[tokio::test]
async fn operation_hold_waits_without_retries_and_a_newer_read_releases_it() {
    let state = host();
    hold_now(&state, Program::Claude);
    let (held_tx, mut held_rx) = tokio::sync::mpsc::unbounded_channel();
    let waiting = {
        let state = state.clone();
        tokio::spawn(async move {
            admit(
                &state,
                "operation-1",
                "operation",
                Program::Claude,
                None,
                |verdict| {
                    let _ = held_tx.send(verdict.clone());
                },
            )
            .await
        })
    };
    assert!(held_rx.recv().await.unwrap().held());
    let view = state.lock().unwrap().quota_gate.view(0, 0);
    assert_eq!(view["holds"][0]["id"], "operation-1");
    assert_eq!(view["holds"][0]["kind"], "operation");
    assert_eq!(view["holds"][0]["checks"], 1);
    let mut waiting = waiting;
    assert!(
        tokio::time::timeout(Duration::from_millis(200), &mut waiting)
            .await
            .is_err()
    );
    assert_eq!(
        state.lock().unwrap().quota_gate.queue[0].checks,
        1,
        "an unchanged gate is not re-evaluated"
    );
    release_now(&state, Program::Claude);
    waiting.await.unwrap().unwrap();
    assert!(state.lock().unwrap().quota_gate.queue.is_empty());
    assert!(held_rx.try_recv().is_err(), "the hold is announced once");
}

#[tokio::test]
async fn launch_hold_is_abandoned_on_disconnect_and_closed_on_shutdown() {
    let state = host();
    hold_now(&state, Program::Claude);
    let (cancel_tx, cancel) = watch::channel(false);
    let abandoned = {
        let state = state.clone();
        tokio::spawn(async move {
            admit_launch(&state, 9, "reserved", Program::Claude, Some("r1"), cancel).await
        })
    };
    drop(cancel_tx);
    let error = abandoned.await.unwrap().unwrap_err();
    assert_eq!(
        error.downcast_ref::<Error>().unwrap().code,
        "quota_hold_abandoned"
    );
    assert!(state.lock().unwrap().quota_gate.queue.is_empty());
    let (_keep, cancel) = watch::channel(false);
    let closing = {
        let state = state.clone();
        tokio::spawn(async move {
            admit_launch(&state, 9, "reserved-2", Program::Claude, None, cancel).await
        })
    };
    state.lock().unwrap().quota_gate.close();
    let error = closing.await.unwrap().unwrap_err();
    assert_eq!(error.downcast_ref::<Error>().unwrap().code, "host_stopping");
}

#[test]
fn native_spawn_refuses_a_hold_and_marks_unknown_sources() {
    let state = host();
    hold_now(&state, Program::Claude);
    let state = state.lock().unwrap();
    let error = admit_now(&state.quota_gate, Program::Claude).unwrap_err();
    assert_eq!(error.downcast_ref::<Error>().unwrap().code, "quota_hold");
    assert_eq!(
        admit_now(&state.quota_gate, Program::Gemini).unwrap(),
        Some("no_admission_source")
    );
    assert_eq!(admit_now(&state.quota_gate, Program::Shell).unwrap(), None);
}
