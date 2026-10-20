use super::*;
use crate::usage::{
    self, BucketCompleteness, BucketSource, CodexObservation, CodexSnapshot, ReadOutcome,
    ReaderContext, RouteObservation, WindowState,
};

const WALL: u64 = 1_000_000;
const START: u64 = 10_000;

fn launch_binding(name: &str) -> LaunchBinding {
    let root = std::env::temp_dir().join("nesvo-session-quota-private");
    LaunchBinding::capture(
        (
            root.join("codex-owned"),
            vec![OsString::from("private-wrapper")],
        ),
        root.join(name),
        root.join("private-home"),
    )
    .unwrap()
}
fn observation(start: u64, used: u8) -> CodexObservation {
    CodexObservation {
        started_at_ms: WALL + start - START,
        finished_at_ms: WALL + start - START + 10,
        started_elapsed_ms: start,
        finished_elapsed_ms: start + 10,
        context: Some(ReaderContext {
            codex_home: "private-home".into(),
            context_id: "private-context".into(),
            route: RouteObservation {
                verdict: RouteVerdict::ChatgptConfiguredOpenai,
                reason: "route_chatgpt_configured_openai",
                config_fingerprint: Some("private-route".into()),
            },
        }),
        outcome: ReadOutcome::Snapshot(CodexSnapshot {
            account_id: Some("private-account".into()),
            ordinary_usage_allowed: Some(true),
            windows: vec![
                usage::LimitWindow {
                    used_percent: used,
                    duration_mins: 300,
                    resets_at: Some(if start < 20_000 { 1010 } else { 2000 }),
                },
                usage::LimitWindow {
                    used_percent: 30,
                    duration_mins: 10080,
                    resets_at: Some(10000),
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
fn snapshot(observation: &mut CodexObservation) -> &mut CodexSnapshot {
    let ReadOutcome::Snapshot(snapshot) = &mut observation.outcome else {
        panic!("Snapshot fixture");
    };
    snapshot
}
fn finish(registry: &mut Registry, id: &str, observation: CodexObservation) {
    let start = observation.started_elapsed_ms;
    registry
        .request(id, observation.started_at_ms, start)
        .unwrap();
    let read = registry.next(start).expect("One queued read");
    assert_eq!(read.id, id);
    registry.finish(id, observation);
}
fn armed() -> (LaunchBinding, Registry, WakeProof) {
    let binding = launch_binding("original-cwd");
    let mut registry = Registry::new([31; 32]);
    let id = registry.register(binding.reader_spec(), false).unwrap();
    finish(&mut registry, &id, observation(START, 92));
    let proof = binding
        .arm(&mut registry, &id, WALL + 100, START + 100)
        .unwrap();
    assert_eq!(proof.reset_elapsed_ms, 20_000);
    (binding, registry, proof)
}
fn release(
    binding: &LaunchBinding,
    registry: &mut Registry,
    proof: &WakeProof,
    elapsed: u64,
) -> Release {
    binding.release(registry, proof, WALL + elapsed - START, elapsed)
}

#[test]
fn exact_post_reset_reader_releases_and_proof_contains_only_opaque_identity_metadata() {
    let (binding, mut registry, proof) = armed();
    assert_eq!(proof.read_started_elapsed_ms, START);
    assert_eq!(proof.revision, 1);
    finish(&mut registry, &proof.reader_id, observation(20_001, 20));
    assert_eq!(
        release(&binding, &mut registry, &proof, 20_100),
        Release::Ready {
            revision: 2,
            read_started_elapsed_ms: 20_001
        }
    );
    let json = serde_json::to_string(&proof).unwrap();
    for private in [
        "private-home",
        "private-context",
        "private-account",
        "private-wrapper",
        "original-cwd",
    ] {
        assert!(!json.contains(private));
    }
    assert_eq!(serde_json::from_str::<WakeProof>(&json).unwrap(), proof);
}

#[test]
fn capture_never_registers_and_requires_resolved_paths_and_explicit_home() {
    let binding = launch_binding("original-cwd");
    let mut registry = Registry::new([31; 32]);
    assert!(registry.next(START).is_none());
    assert_eq!(
        binding
            .arm(&mut registry, &"a".repeat(32), WALL, START)
            .unwrap_err()
            .downcast_ref::<Error>()
            .unwrap()
            .code,
        "quota_wait"
    );
    let spec = binding.reader_spec();
    for (command, directory, home) in [
        (
            (PathBuf::from("relative-command"), vec![]),
            spec.directory.clone(),
            spec.home.clone().unwrap(),
        ),
        (
            spec.command.clone(),
            PathBuf::from("relative-cwd"),
            spec.home.clone().unwrap(),
        ),
        (
            spec.command.clone(),
            spec.directory.clone(),
            PathBuf::from("relative-home"),
        ),
    ] {
        assert!(LaunchBinding::capture(command, directory, home).is_err());
    }
}

#[test]
fn arming_accepts_exhausted_metadata_but_never_claims_release_permission() {
    let binding = launch_binding("original-cwd");
    let mut registry = Registry::new([31; 32]);
    let id = registry.register(binding.reader_spec(), false).unwrap();
    let mut denied = observation(START, 100);
    snapshot(&mut denied).ordinary_usage_allowed = Some(false);
    snapshot(&mut denied).rate_limit_reached = true;
    finish(&mut registry, &id, denied);
    let proof = binding
        .arm(&mut registry, &id, WALL + 100, START + 100)
        .unwrap();
    assert!(matches!(
        release(&binding, &mut registry, &proof, START + 101),
        Release::Hold(_)
    ));
}

#[test]
fn arming_requires_one_fresh_complete_five_hour_window_at_threshold() {
    for variant in 0..6 {
        let binding = launch_binding("original-cwd");
        let mut registry = Registry::new([31; 32]);
        let id = registry.register(binding.reader_spec(), false).unwrap();
        let mut observed = observation(START, 92);
        match variant {
            0 => snapshot(&mut observed).windows[0].used_percent = 89,
            1 => snapshot(&mut observed).complete = false,
            2 => snapshot(&mut observed).windows[0].resets_at = None,
            3 => snapshot(&mut observed).windows[1].duration_mins = 300,
            4 => snapshot(&mut observed).account_id = None,
            5 => {
                observed.context.as_mut().unwrap().route =
                    RouteObservation::unknown("route_config_unavailable")
            }
            _ => unreachable!(),
        }
        finish(&mut registry, &id, observed);
        assert!(
            binding
                .arm(&mut registry, &id, WALL + 100, START + 100)
                .is_err(),
            "variant {variant}"
        );
    }
    let (binding, mut registry, proof) = armed();
    assert!(
        binding
            .arm(&mut registry, &proof.reader_id, WALL + 10_000, 20_000)
            .is_err()
    );
}

#[test]
fn finishing_after_reset_does_not_launder_a_read_started_before_or_at_reset() {
    for start in [19_999, 20_000] {
        let (binding, mut registry, proof) = armed();
        let mut observed = observation(start, 20);
        snapshot(&mut observed).windows[0].resets_at = Some(2000);
        observed.finished_elapsed_ms = 20_100;
        observed.finished_at_ms = WALL + 10_100;
        finish(&mut registry, &proof.reader_id, observed);
        assert_eq!(
            release(&binding, &mut registry, &proof, 20_101),
            Release::Hold("post_reset_read_required")
        );
    }
}

#[test]
fn failed_or_missing_observations_hold_without_using_historical_read_start() {
    let (binding, mut registry, proof) = armed();
    let mut failed = observation(20_001, 20);
    failed.context = None;
    failed.outcome = ReadOutcome::Failure(usage::ReadFailure::Timeout);
    finish(&mut registry, &proof.reader_id, failed);
    let (evidence, _) = registry
        .read_proof(&proof.reader_id, WALL + 10_100, 20_100)
        .unwrap();
    assert_eq!(evidence.started_elapsed_ms, None);
    assert_eq!(
        evidence.view.context_id.as_deref(),
        Some(proof.context_id.as_str()),
        "Display may retain historical identity"
    );
    assert!(matches!(
        release(&binding, &mut registry, &proof, 20_100),
        Release::Hold(_)
    ));
    let mut missing = proof.clone();
    missing.reader_id = "f".repeat(32);
    assert_eq!(
        release(&binding, &mut registry, &missing, 20_100),
        Release::Hold("reader_unavailable")
    );
    finish(&mut registry, &proof.reader_id, observation(25_001, 20));
    assert!(matches!(
        release(&binding, &mut registry, &proof, 25_100),
        Release::Ready { .. }
    ));
}

#[test]
fn known_account_or_configuration_switch_disarms_even_after_it_switches_back() {
    for context_switch in [false, true] {
        let (binding, mut registry, proof) = armed();
        let mut changed = observation(20_001, 20);
        if context_switch {
            changed.context.as_mut().unwrap().context_id = "another-context".into();
            changed.outcome = ReadOutcome::Failure(usage::ReadFailure::ProviderError);
        } else {
            snapshot(&mut changed).account_id = Some("another-account".into());
        }
        finish(&mut registry, &proof.reader_id, changed);
        assert!(matches!(
            release(&binding, &mut registry, &proof, 20_100),
            Release::Disarm(_)
        ));
        finish(&mut registry, &proof.reader_id, observation(25_001, 20));
        assert!(
            matches!(
                release(&binding, &mut registry, &proof, 25_100),
                Release::Disarm(_)
            ),
            "A later return cannot revive the original arm"
        );
    }
}

#[test]
fn failed_route_metadata_holds_without_claiming_a_known_configuration_switch() {
    let (binding, mut registry, proof) = armed();
    let mut failed = observation(20_001, 20);
    let context = failed.context.as_mut().unwrap();
    context.context_id = "route-metadata-unavailable-context".into();
    context.route = RouteObservation::unknown("route_config_unavailable");
    failed.outcome = ReadOutcome::Failure(usage::ReadFailure::ProviderError);
    finish(&mut registry, &proof.reader_id, failed);
    assert!(matches!(
        release(&binding, &mut registry, &proof, 20_100),
        Release::Hold(_)
    ));
    finish(&mut registry, &proof.reader_id, observation(25_001, 20));
    assert!(matches!(
        release(&binding, &mut registry, &proof, 25_100),
        Release::Ready { .. }
    ));
}

#[test]
fn exact_configuration_and_reader_are_required_instead_of_ambient_account_match() {
    let (binding, mut registry, proof) = armed();
    let other = launch_binding("other-cwd");
    let ambient = registry.register(other.reader_spec(), true).unwrap();
    finish(&mut registry, &ambient, observation(20_001, 20));
    assert_eq!(
        binding
            .arm(&mut registry, &ambient, WALL + 10_100, 20_100)
            .unwrap_err()
            .downcast_ref::<Error>()
            .unwrap()
            .code,
        "quota_binding_conflict"
    );
    assert_eq!(
        release(&other, &mut registry, &proof, 20_100),
        Release::Disarm("launch_configuration_changed")
    );
    assert!(
        matches!(
            release(&binding, &mut registry, &proof, 20_100),
            Release::Hold(_)
        ),
        "An unrelated fresh reader cannot release this arm"
    );
    for variant in 0..2 {
        let mut changed = binding.reader_spec();
        if variant == 0 {
            changed.command.1.push("another-wrapper-argument".into());
        } else {
            changed.home = Some(std::env::temp_dir().join("another-private-home"));
        }
        let changed =
            LaunchBinding::capture(changed.command, changed.directory, changed.home.unwrap())
                .unwrap();
        assert_eq!(
            release(&changed, &mut registry, &proof, 20_100),
            Release::Disarm("launch_configuration_changed")
        );
    }
}

#[test]
fn post_reset_release_requires_affirmative_permission_and_every_window_unexhausted() {
    for variant in 0..7 {
        let (binding, mut registry, proof) = armed();
        let mut observed = observation(20_001, 20);
        match variant {
            0 => snapshot(&mut observed).ordinary_usage_allowed = None,
            1 => snapshot(&mut observed).ordinary_usage_allowed = Some(false),
            2 => snapshot(&mut observed).windows[1].used_percent = 100,
            3 => snapshot(&mut observed).windows[0].used_percent = 90,
            4 => snapshot(&mut observed).complete = false,
            5 => snapshot(&mut observed).spend_control_reached = Some(true),
            6 => {
                let context = observed.context.as_mut().unwrap();
                context.context_id = "unknown-route-metadata-context".into();
                context.route = RouteObservation::unknown("route_config_unavailable");
            }
            _ => unreachable!(),
        }
        finish(&mut registry, &proof.reader_id, observed);
        assert!(
            matches!(
                release(&binding, &mut registry, &proof, 20_100),
                Release::Hold(_)
            ),
            "variant {variant}"
        );
    }
}

#[test]
fn a_known_unsupported_route_disarms_instead_of_retrying_another_provider_route() {
    let (binding, mut registry, proof) = armed();
    let mut observed = observation(20_001, 20);
    observed.context.as_mut().unwrap().route.verdict = RouteVerdict::ApiKey;
    finish(&mut registry, &proof.reader_id, observed);
    assert_eq!(
        release(&binding, &mut registry, &proof, 20_100),
        Release::Disarm("quota_route_changed")
    );
}

#[test]
fn clock_highwater_sets_reset_deadline_without_extending_it_after_rollback() {
    let binding = launch_binding("original-cwd");
    let mut registry = Registry::new([31; 32]);
    let id = registry.register(binding.reader_spec(), false).unwrap();
    finish(&mut registry, &id, observation(START, 92));
    registry.view(&id, WALL + 5000, START + 100).unwrap();
    let proof = binding
        .arm(&mut registry, &id, WALL + 100, START + 101)
        .unwrap();
    assert_eq!(proof.reset_elapsed_ms, 15_100);
    let repeated = binding
        .arm(&mut registry, &id, WALL + 101, START + 102)
        .unwrap();
    assert_eq!(repeated.reset_elapsed_ms, proof.reset_elapsed_ms);
}

#[test]
fn malformed_persisted_proof_cannot_supply_resume_authority() {
    let (binding, mut registry, proof) = armed();
    let mut malformed = proof.clone();
    malformed.account_fingerprint = "B".repeat(64);
    assert_eq!(
        release(&binding, &mut registry, &malformed, 20_100),
        Release::Disarm("invalid_wake_proof")
    );
    let mut malformed = proof;
    malformed.reset_elapsed_ms = malformed.read_started_elapsed_ms;
    assert_eq!(
        release(&binding, &mut registry, &malformed, 20_100),
        Release::Disarm("invalid_wake_proof")
    );
}
