use super::*;

fn state() -> State {
    let mut state = State::new(
        std::env::temp_dir(),
        MetadataStore::open(Path::new(":memory:")).unwrap(),
        Launchers::discover(),
    );
    state.provider_quota =
        crate::provider_quota::Tracker::new(&[Program::Codex, Program::Gemini], [9; 32]);
    state.provider_limits = vec![ProviderLimit {
        id: Program::Codex,
        status: "checking",
        windows: vec![],
    }];
    state
}

#[test]
fn refreshes_coalesce_and_cool_down_without_spawning_in_the_command_handler() {
    let mut state = state();
    let (sender, mut receiver) = mpsc::channel(1);
    state
        .quota_refresh
        .push(crate::provider_quota_runtime::RefreshControl {
            program: Program::Codex,
            sender,
            in_flight: false,
            last_started: None,
        });
    let first = state
        .provider_quota_query(Some(Program::Codex), true)
        .unwrap();
    assert_eq!(first["refresh"]["state"], "queued");
    assert_eq!(first["refresh"]["revision"], 1);
    let again = state
        .provider_quota_query(Some(Program::Codex), true)
        .unwrap();
    assert_eq!(again["refresh"], first["refresh"]);
    assert_eq!(receiver.try_recv(), Ok(()));
    assert!(receiver.try_recv().is_err());
    assert!(state.quota_read_started(Program::Codex));
    assert!(!state.quota_read_started(Program::Codex));
    let pending = state
        .provider_quota_query(Some(Program::Codex), true)
        .unwrap();
    assert_eq!(pending["refresh"]["state"], "pending");
    assert!(receiver.try_recv().is_err());
    state.quota_read_finished(Program::Codex);
    let cooldown = state
        .provider_quota_query(Some(Program::Codex), true)
        .unwrap();
    assert_eq!(cooldown["refresh"]["state"], "cooldown");
    assert!(cooldown["refresh"]["retryAfterMs"].as_u64().unwrap() > 0);
    assert!(receiver.try_recv().is_err());
    state.begin_shutdown();
    assert!(!state.quota_read_started(Program::Codex));
}

#[test]
fn quota_queries_validate_installed_sources_and_do_not_create_unknown_providers() {
    let mut state = state();
    let providers = state.provider_quota_query(None, false).unwrap();
    assert_eq!(providers["providers"].as_array().unwrap().len(), 2);
    assert!(state.provider_quota_query(None, true).is_err());
    assert!(
        state
            .provider_quota_query(Some(Program::Shell), false)
            .is_err()
    );
    let unavailable = state
        .provider_quota_query(Some(Program::Claude), false)
        .unwrap_err();
    assert_eq!(
        unavailable
            .downcast_ref::<crate::api_error::Error>()
            .unwrap()
            .code,
        "provider_unavailable"
    );
    let unsupported = state
        .provider_quota_query(Some(Program::Gemini), true)
        .unwrap_err();
    assert_eq!(
        unsupported
            .downcast_ref::<crate::api_error::Error>()
            .unwrap()
            .code,
        "unsupported"
    );
    assert_eq!(providers["providers"][1]["reason"], "unsupported");
}

#[test]
fn failed_observation_invalidates_legacy_wake_freshness_and_clears_live_panel_values() {
    let mut state = state();
    state.limits_read_at = chrono::Utc::now().timestamp();
    state.provider_limits[0].status = "ready";
    state.provider_limits[0].windows = vec![LimitWindow {
        used_percent: 10,
        duration_mins: 300,
        resets_at: Some(chrono::Utc::now().timestamp() + 3600),
    }];
    let now = now_millis();
    let elapsed = crate::event_log::monotonic_millis();
    state.observe_codex_quota(usage::CodexObservation {
        started_at_ms: now,
        finished_at_ms: now,
        started_elapsed_ms: elapsed,
        finished_elapsed_ms: elapsed,
        context: None,
        outcome: usage::ReadOutcome::Failure(usage::ReadFailure::Timeout),
    });
    assert_eq!(state.limits_read_at, 0);
    assert_eq!(state.provider_limits[0].status, "unavailable");
    assert!(state.provider_limits[0].windows.is_empty());
    let queried = state
        .provider_quota_query(Some(Program::Codex), false)
        .unwrap();
    assert_eq!(queried["providers"][0]["revision"], 1);
    assert_eq!(queried["providers"][0]["reason"], "timeout");
    assert_eq!(queried["providers"][0]["ordinaryUsageEligible"], false);
}
