use super::*;
use crate::usage::{
    BucketCompleteness, BucketSource, CodexSnapshot, ReadFailure, WindowState,
    parse_claude_observation,
};
use serde_json::json;

const WALL: u64 = 1_000_000;

fn tracker() -> Tracker {
    Tracker::new(&[Program::Codex, Program::Claude], [19; 32])
}

fn windows() -> Vec<LimitWindow> {
    vec![
        LimitWindow {
            used_percent: 92,
            duration_mins: 300,
            resets_at: Some(10_000),
        },
        LimitWindow {
            used_percent: 41,
            duration_mins: 10_080,
            resets_at: Some(20_000),
        },
    ]
}

fn codex() -> CodexObservation {
    CodexObservation {
        started_at_ms: WALL,
        finished_at_ms: WALL + 100,
        started_elapsed_ms: 10,
        finished_elapsed_ms: 110,
        context: Some(ReaderContext {
            codex_home: "C:/private/quota-test-home".into(),
            context_id: "private-context-identity".into(),
            route: crate::usage::RouteObservation::unknown("fixture_route_unknown"),
        }),
        outcome: ReadOutcome::Snapshot(CodexSnapshot {
            account_id: Some("private-reader-account".into()),
            ordinary_usage_allowed: Some(true),
            windows: windows(),
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

fn snapshot(observation: &mut CodexObservation) -> &mut CodexSnapshot {
    let ReadOutcome::Snapshot(snapshot) = &mut observation.outcome else {
        panic!("Test needs a full-read snapshot");
    };
    snapshot
}

fn view(tracker: &mut Tracker, program: Program, wall_ms: u64, elapsed_ms: u64) -> View {
    tracker
        .view(wall_ms, elapsed_ms)
        .into_iter()
        .find(|view| view.program == program)
        .expect("Installed provider must retain its tracker")
}

fn claude(observed_at_ms: u64) -> ClaudeObservation {
    parse_claude_observation(
        &json!({"at":1000,"rate_limits":{
            "five_hour":{"used_percentage":92,"resets_at":10_000},
            "seven_day":{"used_percentage":41,"resets_at":20_000}
        }}),
        observed_at_ms,
    )
}

#[test]
fn only_installed_unique_provider_trackers_exist() {
    let mut tracker = Tracker::new(
        &[
            Program::Claude,
            Program::Gemini,
            Program::Claude,
            Program::Shell,
        ],
        [5; 32],
    );
    tracker.apply_codex(codex());
    let views = tracker.view(WALL, 0);
    assert_eq!(views.len(), 2);
    assert_eq!(views[0].program, Program::Claude);
    assert_eq!(views[0].status, "checking");
    assert_eq!(views[0].revision, 0);
    assert_eq!(views[0].attempted_at, None);
    assert_eq!(views[1].program, Program::Gemini);
    assert_eq!(views[1].status, "unavailable");
    assert_eq!(views[1].reason, "unsupported");
    assert!(views.iter().all(|view| !view.ordinary_usage_eligible));
}

#[test]
fn unchanged_reads_and_failures_advance_revision_without_retaining_authority() {
    let mut tracker = tracker();
    tracker.apply_codex(codex());
    let first = view(&mut tracker, Program::Codex, WALL + 100, 110);
    assert_eq!(first.status, "ready");
    assert!(first.ordinary_usage_eligible);
    assert_eq!(first.ordinary_usage_allowed, Some(true));
    assert_eq!(first.scope, "readerSnapshotOnly");

    let mut repeated = codex();
    repeated.started_at_ms += 1000;
    repeated.finished_at_ms += 1000;
    repeated.started_elapsed_ms += 1000;
    repeated.finished_elapsed_ms += 1000;
    tracker.apply_codex(repeated);
    let second = view(&mut tracker, Program::Codex, WALL + 1100, 1110);
    assert_eq!(second.revision, 2);
    assert_eq!(second.windows, first.windows);

    let mut failed = codex();
    failed.started_at_ms += 2000;
    failed.finished_at_ms += 2000;
    failed.started_elapsed_ms += 2000;
    failed.finished_elapsed_ms += 2000;
    failed.outcome = ReadOutcome::Failure(ReadFailure::Timeout);
    tracker.apply_codex(failed);
    let failed = view(&mut tracker, Program::Codex, WALL + 2100, 2110);
    assert_eq!(failed.revision, 3);
    assert_eq!(failed.status, "unavailable");
    assert_eq!(failed.reason, "timeout");
    assert_eq!(failed.freshness, "unavailable");
    assert_eq!(failed.attempted_at, Some(WALL + 2000));
    assert_eq!(failed.observed_at, second.observed_at);
    assert_eq!(failed.windows, second.windows);
    assert_eq!(failed.ordinary_usage_allowed, None);
    assert!(!failed.complete);
    assert!(!failed.ordinary_usage_eligible);
    assert_eq!(failed.eligibility_reason, "timeout");
}

#[test]
fn freshness_starts_before_io_and_uses_elapsed_time_during_wall_rollback() {
    let mut tracker = tracker();
    let mut observation = codex();
    observation.finished_at_ms = WALL + 179_900;
    observation.finished_elapsed_ms = 179_910;
    tracker.apply_codex(observation);
    let fresh = view(&mut tracker, Program::Codex, WALL - 100_000, 179_999);
    assert_eq!(fresh.status, "ready");
    assert_eq!(fresh.age_ms, Some(179_989));
    assert_eq!(fresh.expires_at, Some(WALL + READ_FRESHNESS_MS));
    let expired = view(&mut tracker, Program::Codex, WALL - 100_000, 180_010);
    assert_eq!(expired.status, "stale");
    assert_eq!(expired.reason, "read_expired");
    assert_eq!(expired.ordinary_usage_allowed, None);
    assert!(!expired.ordinary_usage_eligible);
    let invalid_clock = view(&mut tracker, Program::Codex, WALL + 200_000, 179_909);
    assert_eq!(invalid_clock.status, "unavailable");
    assert_eq!(invalid_clock.reason, "clock_regressed");
}

#[test]
fn repeated_claude_cache_preserves_source_age_across_wall_rollback() {
    let mut tracker = tracker();
    tracker.apply_claude(claude(WALL), 0, 10);
    let original = view(&mut tracker, Program::Claude, WALL + 10, 10);
    assert_eq!(original.status, "ready");
    assert_eq!(original.source_at, Some(WALL));
    assert_eq!(original.ordinary_usage_allowed, None);
    assert!(!original.ordinary_usage_eligible);
    assert_eq!(
        original.eligibility_reason,
        "backend_permission_unavailable"
    );

    // Reading the same bytes near their source deadline refreshes the read,
    // while the original cache source keeps its independent 900-second age.
    tracker.apply_claude(claude(WALL - 50_000), 899_000, 899_010);
    let repeated = view(&mut tracker, Program::Claude, WALL - 49_990, 899_010);
    assert_eq!(repeated.revision, 2);
    assert_eq!(repeated.status, "ready");
    assert_eq!(repeated.source_at, Some(WALL));
    assert_eq!(repeated.age_ms, Some(899_010));
    assert_eq!(repeated.expires_at, Some(WALL + CLAUDE_SOURCE_FRESHNESS_MS));
    let expired = view(&mut tracker, Program::Claude, WALL - 49_000, 900_000);
    assert_eq!(expired.status, "stale");
    assert_eq!(expired.reason, "stale_cache");
    assert_eq!(expired.age_ms, Some(CLAUDE_SOURCE_FRESHNESS_MS));

    tracker.apply_claude(claude(WALL - 49_000), 900_000, 900_010);
    let attempted_expired = view(&mut tracker, Program::Claude, WALL - 48_990, 900_010);
    assert_eq!(attempted_expired.revision, 3);
    assert_eq!(attempted_expired.status, "stale");
    assert_eq!(attempted_expired.reason, "stale_cache");
    assert_eq!(attempted_expired.observed_at, repeated.observed_at);
    assert!(!attempted_expired.complete);
}

#[test]
fn claude_read_freshness_and_failure_are_independent_of_source_freshness() {
    let mut tracker = tracker();
    tracker.apply_claude(claude(WALL), 0, 1);
    let expired = view(
        &mut tracker,
        Program::Claude,
        WALL + READ_FRESHNESS_MS,
        READ_FRESHNESS_MS,
    );
    assert_eq!(expired.reason, "read_expired");

    tracker.apply_claude(
        ClaudeObservation {
            source_at_ms: None,
            observed_at_ms: WALL + READ_FRESHNESS_MS + 1,
            windows: Vec::new(),
            reason: "cache_unavailable",
        },
        READ_FRESHNESS_MS + 1,
        READ_FRESHNESS_MS + 2,
    );
    let failed = view(
        &mut tracker,
        Program::Claude,
        WALL + READ_FRESHNESS_MS + 2,
        READ_FRESHNESS_MS + 2,
    );
    assert_eq!(failed.revision, 2);
    assert_eq!(failed.reason, "cache_unavailable");
    assert_eq!(failed.freshness, "unavailable");
    assert_eq!(failed.windows, windows());
    assert!(!failed.ordinary_usage_eligible);
}

#[test]
fn incomplete_advertised_windows_cannot_recover_permission_from_percentages() {
    for permission in [None, Some(true)] {
        let mut tracker = tracker();
        let mut observation = codex();
        let sample = snapshot(&mut observation);
        sample.ordinary_usage_allowed = permission;
        sample.complete = false;
        sample.completeness.secondary = WindowState::Incomplete;
        sample.windows.pop();
        tracker.apply_codex(observation);
        let partial = view(&mut tracker, Program::Codex, WALL + 100, 110);
        assert_eq!(partial.status, "partial");
        assert_eq!(partial.freshness, "fresh");
        assert!(!partial.complete);
        assert!(!partial.ordinary_usage_eligible);
        assert_eq!(partial.eligibility_reason, "incomplete_snapshot");
    }
    let mut tracker = tracker();
    let mut observation = codex();
    snapshot(&mut observation).ordinary_usage_allowed = None;
    tracker.apply_codex(observation);
    let unknown = view(&mut tracker, Program::Codex, WALL + 100, 110);
    assert_eq!(unknown.status, "ready");
    assert!(unknown.complete);
    assert_eq!(unknown.ordinary_usage_allowed, None);
    assert_eq!(unknown.eligibility_reason, "backend_permission_unavailable");
    assert!(!unknown.ordinary_usage_eligible);
}

#[test]
fn optional_windows_need_explicit_permission_and_never_create_unreported_capacity() {
    for missing in [WindowState::Missing, WindowState::Null] {
        for retained in [None, Some(0), Some(1)] {
            for permission in [None, Some(false), Some(true)] {
                let mut tracker = tracker();
                let mut observation = codex();
                let sample = snapshot(&mut observation);
                sample.ordinary_usage_allowed = permission;
                sample.completeness = BucketCompleteness {
                    primary: if retained == Some(0) {
                        WindowState::Complete
                    } else {
                        missing
                    },
                    secondary: if retained == Some(1) {
                        WindowState::Complete
                    } else {
                        missing
                    },
                };
                sample.windows = retained
                    .map(|index| vec![windows()[index].clone()])
                    .unwrap_or_default();
                tracker.apply_codex(observation);
                let observed = view(&mut tracker, Program::Codex, WALL + 100, 110);
                assert_eq!(observed.status, "ready");
                assert!(observed.complete);
                assert_eq!(observed.windows.len(), usize::from(retained.is_some()));
                assert_eq!(observed.ordinary_usage_allowed, permission);
                assert_eq!(observed.ordinary_usage_eligible, permission == Some(true));
                assert_eq!(
                    observed.eligibility_reason,
                    match permission {
                        None => "backend_permission_unavailable",
                        Some(false) => "backend_denied",
                        Some(true) => "observed",
                    }
                );
                assert!(observed.expires_at.unwrap() <= WALL + READ_FRESHNESS_MS);
            }
        }
    }
}

#[test]
fn one_window_denials_and_elapsed_resets_hold_and_failed_read_revokes_permission() {
    for case in 0..5 {
        let mut tracker = tracker();
        let mut observation = codex();
        let sample = snapshot(&mut observation);
        sample.windows.remove(0);
        sample.completeness.primary = WindowState::Null;
        match case {
            0 => sample.spend_control_reached = Some(true),
            1 => sample.rate_limit_reached = true,
            2 => sample.windows[0].used_percent = 100,
            3 => sample.windows[0].resets_at = Some(999),
            _ => {}
        }
        tracker.apply_codex(observation);
        let observed = view(&mut tracker, Program::Codex, WALL + 100, 110);
        assert_eq!(observed.ordinary_usage_eligible, case == 4);
        let mut failed = codex();
        failed.started_at_ms += 200;
        failed.finished_at_ms += 200;
        failed.started_elapsed_ms += 200;
        failed.finished_elapsed_ms += 200;
        failed.outcome = ReadOutcome::Failure(ReadFailure::ProviderError);
        tracker.apply_codex(failed);
        let revoked = view(&mut tracker, Program::Codex, WALL + 300, 310);
        assert!(!revoked.ordinary_usage_eligible);
        assert_eq!(revoked.ordinary_usage_allowed, None);
        assert_eq!(revoked.reason, "provider_error");
        assert_eq!(revoked.windows.len(), 1);
    }
}

#[test]
fn fresh_denial_and_exhaustion_remain_visible_without_positive_permission() {
    for (case, expected) in [
        (0, "backend_denied"),
        (1, "spend_control_reached"),
        (2, "rate_limit_reached"),
        (3, "quota_exhausted"),
    ] {
        let mut tracker = tracker();
        let mut observation = codex();
        let sample = snapshot(&mut observation);
        match case {
            0 => sample.ordinary_usage_allowed = Some(false),
            1 => sample.spend_control_reached = Some(true),
            2 => sample.rate_limit_reached = true,
            _ => sample.windows[1].used_percent = 100,
        }
        tracker.apply_codex(observation);
        let observed = view(&mut tracker, Program::Codex, WALL + 100, 110);
        assert_eq!(observed.status, "ready");
        assert_eq!(observed.freshness, "fresh");
        assert!(observed.complete);
        assert_eq!(observed.eligibility_reason, expected);
        assert!(!observed.ordinary_usage_eligible);
    }
}

#[test]
fn missing_or_elapsed_resets_and_identity_gaps_never_qualify() {
    for reset in [None, Some(1000), Some(0), Some(-1)] {
        let mut tracker = tracker();
        let mut observation = codex();
        snapshot(&mut observation).windows[0].resets_at = reset;
        tracker.apply_codex(observation);
        let observed = view(&mut tracker, Program::Codex, WALL + 100, 110);
        assert!(!observed.ordinary_usage_eligible);
        assert_ne!(observed.eligibility_reason, "observed");
    }
    for missing_context in [false, true] {
        let mut tracker = tracker();
        let mut observation = codex();
        let expected = if missing_context {
            observation.context = None;
            "context_unavailable"
        } else {
            snapshot(&mut observation).account_id = None;
            "account_identity_unavailable"
        };
        tracker.apply_codex(observation);
        let observed = view(&mut tracker, Program::Codex, WALL + 100, 110);
        assert_eq!(observed.status, "ready");
        assert_eq!(observed.eligibility_reason, expected);
        assert!(!observed.ordinary_usage_eligible);
    }
}

#[test]
fn wall_rollback_cannot_revive_an_elapsed_window_after_a_new_read() {
    let mut tracker = tracker();
    let mut observation = codex();
    snapshot(&mut observation).windows[0].resets_at = Some(1100);
    tracker.apply_codex(observation.clone());
    let expired = view(&mut tracker, Program::Codex, WALL - 100_000, 120_010);
    assert_eq!(expired.status, "stale");
    assert_eq!(expired.reason, "window_reset_elapsed");

    observation.started_at_ms = WALL - 100_000;
    observation.finished_at_ms = WALL - 99_900;
    observation.started_elapsed_ms = 130_010;
    observation.finished_elapsed_ms = 130_110;
    tracker.apply_codex(observation);
    let reread = view(&mut tracker, Program::Codex, WALL - 99_900, 130_110);
    assert_eq!(reread.revision, 2);
    assert_eq!(reread.status, "stale");
    assert_eq!(reread.reason, "window_reset_elapsed");
    assert!(!reread.ordinary_usage_eligible);
}

#[test]
fn forward_projection_then_wall_rollback_never_revives_the_same_revision() {
    let mut tracker = tracker();
    let mut observation = codex();
    snapshot(&mut observation).windows[0].resets_at = Some(1100);
    tracker.apply_codex(observation);
    let fresh = view(&mut tracker, Program::Codex, WALL + 100, 110);
    assert_eq!(fresh.status, "ready");
    assert!(fresh.ordinary_usage_eligible);

    let forward = view(&mut tracker, Program::Codex, WALL + 200_000, 120);
    assert_eq!(forward.status, "stale");
    assert_eq!(forward.reason, "window_reset_elapsed");
    let rollback = view(&mut tracker, Program::Codex, WALL + 120, 130);
    assert_eq!(rollback.revision, fresh.revision);
    assert_eq!(rollback.observed_at, fresh.observed_at);
    assert_eq!(rollback.status, "stale");
    assert_eq!(rollback.reason, "window_reset_elapsed");
    assert_eq!(rollback.freshness, "stale");
    assert_eq!(rollback.ordinary_usage_allowed, None);
    assert!(!rollback.ordinary_usage_eligible);
}

#[test]
fn projected_claude_source_expiry_survives_rollback_and_repeated_cache_reads() {
    let mut tracker = tracker();
    tracker.apply_claude(claude(WALL), 0, 10);
    let initial = view(&mut tracker, Program::Claude, WALL + 10, 10);
    let forward = view(
        &mut tracker,
        Program::Claude,
        WALL + CLAUDE_SOURCE_FRESHNESS_MS,
        100,
    );
    assert_eq!(forward.reason, "stale_cache");
    let rollback = view(&mut tracker, Program::Claude, WALL + 110, 110);
    assert_eq!(rollback.revision, initial.revision);
    assert_eq!(rollback.reason, "stale_cache");
    assert_eq!(rollback.age_ms, Some(CLAUDE_SOURCE_FRESHNESS_MS + 10));
    tracker.apply_claude(claude(WALL + 110), 110, 120);
    let repeated = view(&mut tracker, Program::Claude, WALL + 120, 120);
    assert_eq!(repeated.revision, initial.revision + 1);
    assert_eq!(repeated.reason, "stale_cache");
    assert_eq!(repeated.observed_at, initial.observed_at);
    assert_eq!(repeated.age_ms, Some(CLAUDE_SOURCE_FRESHNESS_MS + 20));
    assert!(!repeated.complete);
    assert!(!repeated.ordinary_usage_eligible);
}

#[test]
fn projection_during_delayed_publication_does_not_reject_a_valid_completed_read() {
    let mut tracker = tracker();
    tracker.apply_codex(codex());
    let projected = view(&mut tracker, Program::Codex, WALL + 290, 300);
    assert_eq!(projected.status, "ready");
    let mut delayed = codex();
    delayed.started_at_ms = WALL + 190;
    delayed.finished_at_ms = WALL + 240;
    delayed.started_elapsed_ms = 200;
    delayed.finished_elapsed_ms = 250;
    tracker.apply_codex(delayed);
    let published = view(&mut tracker, Program::Codex, WALL + 300, 310);
    assert_eq!(published.revision, 2);
    assert_eq!(published.status, "ready");
    assert_eq!(published.reason, "observed");
    assert_eq!(published.observed_at, Some(WALL + 240));
    assert_eq!(published.age_ms, Some(110));
    assert!(published.ordinary_usage_eligible);
}

#[test]
fn malformed_elapsed_timing_invalidates_a_previous_success_and_advances_revision() {
    let mut tracker = tracker();
    tracker.apply_codex(codex());
    let mut malformed = codex();
    malformed.started_elapsed_ms = 200;
    malformed.finished_elapsed_ms = 199;
    tracker.apply_codex(malformed);
    let failed = view(&mut tracker, Program::Codex, WALL + 200, 210);
    assert_eq!(failed.revision, 2);
    assert_eq!(failed.reason, "clock_regressed");
    assert_eq!(failed.windows, windows());
    assert_eq!(failed.ordinary_usage_allowed, None);
    assert!(!failed.ordinary_usage_eligible);
}

#[test]
fn private_account_and_context_fingerprints_change_without_leaking_raw_metadata() {
    let mut tracker = tracker();
    tracker.apply_codex(codex());
    let original = view(&mut tracker, Program::Codex, WALL + 100, 110);
    let encoded = serde_json::to_string(&original).unwrap();
    for private in [
        "private-reader-account",
        "private-context-identity",
        "C:/private/quota-test-home",
        "codexHome",
        "accountId",
    ] {
        assert!(!encoded.contains(private));
    }
    for fingerprint in [&original.context_id, &original.account_fingerprint] {
        let fingerprint = fingerprint.as_ref().unwrap();
        assert_eq!(fingerprint.len(), 64);
        assert!(
            fingerprint
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
    }

    let mut changed = codex();
    snapshot(&mut changed).account_id = Some("different-private-account".into());
    tracker.apply_codex(changed.clone());
    let changed_account = view(&mut tracker, Program::Codex, WALL + 100, 110);
    assert_eq!(changed_account.context_id, original.context_id);
    assert_ne!(
        changed_account.account_fingerprint,
        original.account_fingerprint
    );
    changed.context.as_mut().unwrap().codex_home = "C:/another-private-home".into();
    tracker.apply_codex(changed);
    let changed_context = view(&mut tracker, Program::Codex, WALL + 100, 110);
    assert_ne!(changed_context.context_id, changed_account.context_id);
    assert_eq!(
        changed_context.account_fingerprint,
        changed_account.account_fingerprint
    );

    let mut next_epoch = Tracker::new(&[Program::Codex], [20; 32]);
    next_epoch.apply_codex(codex());
    let next_epoch = view(&mut next_epoch, Program::Codex, WALL + 100, 110);
    assert_ne!(next_epoch.context_id, original.context_id);
    assert_ne!(next_epoch.account_fingerprint, original.account_fingerprint);
}

#[test]
fn unknown_cache_reason_is_redacted_and_cannot_become_authoritative() {
    let mut tracker = tracker();
    let mut observation = claude(WALL);
    observation.reason = "private raw provider failure text";
    tracker.apply_claude(observation, 0, 1);
    let observed = view(&mut tracker, Program::Claude, WALL + 1, 1);
    assert_eq!(observed.reason, "invalid_response");
    assert_eq!(observed.ordinary_usage_allowed, None);
    assert!(
        !serde_json::to_string(&observed)
            .unwrap()
            .contains("private raw")
    );
}
