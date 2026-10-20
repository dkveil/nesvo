use super::*;

#[cfg(windows)]
#[test]
fn git_and_native_extended_windows_paths_share_one_receipt_bound_reader() {
    let mut registry = Registry::new([9; 32]);
    registry.reserve_derived(&receipt(0)).unwrap();
    let id = registry
        .consume_derived(&receipt(0), spec("C:/Quota/worktree"))
        .unwrap();
    assert_eq!(
        registry
            .consume_derived(&receipt(0), spec(r"\\?\C:\Quota\worktree"))
            .unwrap(),
        id
    );
    assert_eq!(
        registry
            .register(spec(r"\\?\C:\Quota\worktree"), false)
            .unwrap(),
        id
    );
    assert_eq!(registry.slots.len(), 1);
    registry.release_derived(&receipt(0));
    assert!(
        registry.view(&id, 1_000_100, 110).is_some(),
        "Owner promotion retains the same reader"
    );
}
use crate::usage::{
    BucketCompleteness, BucketSource, CodexObservation, CodexSnapshot, ReadOutcome, ReaderContext,
    RouteObservation, RouteVerdict, WindowState,
};

fn spec(name: &str) -> ReaderSpec {
    ReaderSpec {
        command: (PathBuf::from("owned-fixture"), vec![]),
        directory: PathBuf::from(name),
        home: Some(PathBuf::from("private-home")),
    }
}
fn receipt(index: usize) -> String {
    format!("{index:032x}")
}
fn observed(context: &str, account: &str, permitted: bool) -> CodexObservation {
    CodexObservation {
        started_at_ms: 1_000_000,
        finished_at_ms: 1_000_100,
        started_elapsed_ms: 10,
        finished_elapsed_ms: 110,
        context: Some(ReaderContext {
            codex_home: "private-home".into(),
            context_id: context.into(),
            route: RouteObservation {
                verdict: RouteVerdict::ChatgptConfiguredOpenai,
                reason: "route_chatgpt_configured_openai",
                config_fingerprint: None,
            },
        }),
        outcome: ReadOutcome::Snapshot(CodexSnapshot {
            account_id: Some(account.into()),
            ordinary_usage_allowed: Some(permitted),
            windows: vec![
                usage::LimitWindow {
                    used_percent: if permitted { 20 } else { 100 },
                    duration_mins: 300,
                    resets_at: Some(10_000),
                },
                usage::LimitWindow {
                    used_percent: 20,
                    duration_mins: 10080,
                    resets_at: Some(20_000),
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
            rate_limit_reached: !permitted,
        }),
    }
}
#[test]
fn contexts_coalesce_without_evicting_bound_readers_and_transients_reclaim_capacity() {
    let mut registry = Registry::new([9; 32]);
    let first = registry.register(spec("first"), true).unwrap();
    assert_eq!(registry.register(spec("first"), false).unwrap(), first);
    assert_eq!(registry.ambient(), Some(first.as_str()));
    for index in 1..CAPACITY {
        registry.reserve_derived(&receipt(index)).unwrap();
        registry
            .consume_derived(&receipt(index), spec(&format!("worktree-{index}")))
            .unwrap();
    }
    assert!(registry.register(spec("overflow"), false).is_err());
    registry.release_derived(&receipt(1));
    registry.register(spec("overflow"), false).unwrap();
    registry.release_derived(&receipt(0));
    assert!(registry.view(&first, 1_000_100, 110).is_some());
}
#[test]
fn reads_rotate_and_coalesce_refreshes_under_a_monotonic_cooldown() {
    let mut registry = Registry::new([9; 32]);
    let first = registry.register(spec("first"), false).unwrap();
    let second = registry.register(spec("second"), false).unwrap();
    assert_eq!(registry.next(10).unwrap().id, first);
    assert_eq!(
        registry.request(&first, 1_000_100, 110).unwrap()["state"],
        "pending"
    );
    assert_eq!(registry.next(11).unwrap().id, second);
    assert!(registry.next(12).is_none());
    registry.finish(&first, observed("first-context", "first-account", true));
    assert_eq!(
        registry.request(&first, 1_000_100, 110).unwrap()["state"],
        "cooldown"
    );
    assert_eq!(
        registry.request(&first, 1_005_100, 5110).unwrap()["state"],
        "queued"
    );
    assert_eq!(registry.next(5110).unwrap().id, first);
}
#[test]
fn every_new_observation_revokes_prior_authority_without_leaking_paths_or_identity() {
    let mut registry = Registry::new([9; 32]);
    let id = registry.register(spec("private-workspace"), true).unwrap();
    registry.next(10).unwrap();
    registry.finish(&id, observed("private-context", "private-account", true));
    let first = registry.observations(1_000_100, 110).pop().unwrap();
    assert!(first.eligible);
    assert!(registry.observations(1_000_101, 111).is_empty());
    let binding = first.binding.unwrap();
    assert!(registry.ready(&id, &binding.account_fingerprint, 1_000_101, 111));
    let public = registry
        .public_view(&id, 1_000_101, 111)
        .unwrap()
        .to_string();
    for private in [
        "private-context",
        "private-account",
        "private-home",
        "private-workspace",
        "expiresElapsed",
    ] {
        assert!(!public.contains(private), "private reader context leaked");
    }
    registry.request(&id, 1_005_100, 5110).unwrap();
    registry.next(5110).unwrap();
    let mut failed = observed("private-context", "private-account", true);
    failed.outcome = ReadOutcome::Failure(usage::ReadFailure::Timeout);
    registry.finish(&id, failed);
    let failure = registry.observations(1_005_100, 5110).pop().unwrap();
    assert_eq!(failure.source_id, first.source_id);
    assert!(failure.revision > first.revision);
    assert!(!failure.eligible);
    assert!(!registry.ready(&id, &binding.account_fingerprint, 1_005_100, 5110));
}
#[test]
fn derived_readers_require_matching_account_and_known_route_without_publishing_job_authority() {
    let mut registry = Registry::new([9; 32]);
    registry.reserve_derived(&receipt(1)).unwrap();
    let id = registry
        .consume_derived(&receipt(1), spec("worktree"))
        .unwrap();
    registry.next(10).unwrap();
    registry.finish(&id, observed("worktree-context", "different-account", true));
    assert!(registry.observations(1_000_100, 110).is_empty());
    let view = registry.view(&id, 1_000_100, 110).unwrap();
    assert!(!registry.ready(&id, "unrelated-fingerprint", 1_000_100, 110));
    assert!(registry.ready(
        &id,
        view.account_fingerprint.as_deref().unwrap(),
        1_000_100,
        110
    ));
    registry.request(&id, 1_005_100, 5110).unwrap();
    registry.next(5110).unwrap();
    let mut unknown = observed("worktree-context", "different-account", true);
    unknown.context.as_mut().unwrap().route = RouteObservation::unknown("config_read_failed");
    registry.finish(&id, unknown);
    let view = registry.view(&id, 1_005_100, 5110).unwrap();
    assert!(
        view.ordinary_usage_eligible,
        "independent quota display remains available"
    );
    assert!(!registry.ready(
        &id,
        view.account_fingerprint.as_deref().unwrap(),
        1_005_100,
        5110
    ));
}
#[test]
fn writer_deadline_expires_monotonically_and_does_not_extend_after_wall_clock_rollback() {
    let mut registry = Registry::new([9; 32]);
    let id = registry.register(spec("first"), true).unwrap();
    registry.next(10).unwrap();
    registry.finish(&id, observed("context", "account", true));
    let granted = registry.observations(1_000_100, 110).pop().unwrap();
    assert_eq!(granted.expires_elapsed_ms, 180010);
    assert!(registry.observations(999_000, 180009).is_empty());
    let expired = registry.observations(999_000, 180010).pop().unwrap();
    assert!(!expired.eligible);
    assert_eq!(expired.expires_elapsed_ms, 180010);
    assert!(expired.revision > granted.revision);
}

#[test]
fn forward_clock_shortens_still_positive_writer_permission_before_expiry() {
    let mut registry = Registry::new([9; 32]);
    let id = registry.register(spec("first"), true).unwrap();
    registry.next(10).unwrap();
    let mut observation = observed("context", "account", true);
    let ReadOutcome::Snapshot(snapshot) = &mut observation.outcome else {
        panic!("snapshot fixture");
    };
    snapshot.windows[0].resets_at = Some(1100);
    registry.finish(&id, observation);
    let original = registry.observations(1_000_100, 110).pop().unwrap();
    assert!(original.eligible);
    let shortened = registry.observations(1_099_000, 111).pop().unwrap();
    assert!(shortened.eligible);
    assert!(shortened.revision > original.revision);
    assert_eq!(shortened.expires_elapsed_ms, 1111);
    assert!(shortened.expires_elapsed_ms < original.expires_elapsed_ms);
    assert!(registry.observations(1_099_001, 112).is_empty());
}

#[test]
fn derived_capacity_is_reserved_before_setup_and_competing_receipts_cannot_steal_it() {
    let mut registry = Registry::new([9; 32]);
    for index in 0..CAPACITY - 1 {
        registry
            .register(spec(&format!("pinned-{index}")), false)
            .unwrap();
    }
    registry.reserve_derived(&receipt(1)).unwrap();
    registry.reserve_derived(&receipt(1)).unwrap();
    assert_eq!(
        registry.used_capacity(),
        CAPACITY,
        "Repeated wait reserves exactly one slot"
    );
    assert!(registry.register(spec("owner-overflow"), false).is_err());
    let error = registry.reserve_derived(&receipt(2)).unwrap_err();
    assert_eq!(
        error
            .downcast_ref::<crate::api_error::Error>()
            .unwrap()
            .code,
        "quota_wait"
    );
    assert_eq!(
        registry.slots.len(),
        CAPACITY - 1,
        "Capacity refusal does not register a prepared reader"
    );
    let reader = registry
        .consume_derived(&receipt(1), spec("original-worktree"))
        .unwrap();
    assert_eq!(registry.used_capacity(), CAPACITY);
    assert_eq!(
        registry
            .consume_derived(&receipt(1), spec("original-worktree"))
            .unwrap(),
        reader
    );
    assert!(
        registry
            .consume_derived(&receipt(1), spec("another-worktree"))
            .is_err()
    );
    assert!(
        registry
            .consume_derived(&receipt(2), spec("original-worktree"))
            .is_err()
    );
    registry.release_derived(&receipt(1));
    registry.release_derived(&receipt(1));
    assert_eq!(registry.used_capacity(), CAPACITY - 1);
    registry.reserve_derived(&receipt(2)).unwrap();
    assert_eq!(registry.used_capacity(), CAPACITY);
}

#[test]
fn a_full_pinned_registry_holds_before_any_derived_reader_can_be_prepared() {
    let mut registry = Registry::new([9; 32]);
    for index in 0..CAPACITY {
        registry
            .register(spec(&format!("pinned-{index}")), false)
            .unwrap();
    }
    let error = registry.reserve_derived(&receipt(1)).unwrap_err();
    assert_eq!(
        error
            .downcast_ref::<crate::api_error::Error>()
            .unwrap()
            .code,
        "quota_wait"
    );
    assert!(registry.reservations.is_empty());
    assert!(
        registry
            .consume_derived(&receipt(1), spec("must-not-create-a-worktree"))
            .is_err()
    );
    assert_eq!(registry.slots.len(), CAPACITY);
}

#[test]
fn owner_coalescing_and_competing_consumers_release_only_their_exact_reservation() {
    let mut registry = Registry::new([9; 32]);
    let shared = registry.register(spec("shared"), true).unwrap();
    registry.reserve_derived(&receipt(1)).unwrap();
    let pinned = registry
        .register(spec("owner-inspected-worktree"), false)
        .unwrap();
    assert_eq!(
        registry
            .consume_derived(&receipt(1), spec("owner-inspected-worktree"))
            .unwrap(),
        pinned
    );
    registry.release_derived(&receipt(1));
    assert!(registry.view(&pinned, 1_000_100, 110).is_some());
    assert!(registry.view(&shared, 1_000_100, 110).is_some());

    for index in [2, 3] {
        registry.reserve_derived(&receipt(index)).unwrap();
    }
    let first = registry
        .consume_derived(&receipt(2), spec("same-derived-worktree"))
        .unwrap();
    assert_eq!(
        registry
            .consume_derived(&receipt(3), spec("same-derived-worktree"))
            .unwrap(),
        first
    );
    registry.release_derived(&receipt(2));
    assert!(
        registry.view(&first, 1_000_100, 110).is_some(),
        "Another live receipt still owns this reader"
    );
    registry.release_derived(&receipt(3));
    assert!(registry.view(&first, 1_000_100, 110).is_none());

    registry.reserve_derived(&receipt(4)).unwrap();
    let promoted = registry
        .consume_derived(&receipt(4), spec("promoted-worktree"))
        .unwrap();
    assert_eq!(
        registry.register(spec("promoted-worktree"), false).unwrap(),
        promoted
    );
    registry.release_derived(&receipt(4));
    assert!(
        registry.view(&promoted, 1_000_100, 110).is_some(),
        "An owner query pins a reader even after consumption"
    );
}

#[test]
fn cleanup_releases_pending_capacity_and_an_in_flight_completion_cannot_resurrect_a_reader() {
    let mut registry = Registry::new([9; 32]);
    registry.reserve_derived(&receipt(1)).unwrap();
    registry.release_derived(&receipt(1));
    assert_eq!(registry.used_capacity(), 0);
    registry.reserve_derived(&receipt(2)).unwrap();
    let reader = registry
        .consume_derived(&receipt(2), spec("in-flight-worktree"))
        .unwrap();
    assert_eq!(registry.next(10).unwrap().id, reader);
    registry.release_derived(&receipt(2));
    assert_eq!(registry.used_capacity(), 0);
    registry.finish(&reader, observed("late-context", "late-account", true));
    assert!(registry.view(&reader, 1_000_100, 110).is_none());
    assert!(registry.observations(1_000_100, 110).is_empty());
}
