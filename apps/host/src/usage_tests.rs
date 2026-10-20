use super::*;

fn full() -> Value {
    json!({"id":2,"result":{"accountId":"reader-workspace","ordinaryUsageAllowed":true,"rateLimits":{"primary":{"usedPercent":10,"windowDurationMins":300,"resetsAt":4000},"secondary":{"usedPercent":20,"windowDurationMins":10080,"resetsAt":8000}}}})
}

#[test]
fn full_snapshot_preserves_backend_identity_permission_and_bucket_evidence() {
    let snapshot = parse_snapshot(&full()).unwrap();
    assert_eq!(snapshot.account_id.as_deref(), Some("reader-workspace"));
    assert_eq!(snapshot.ordinary_usage_allowed, Some(true));
    assert!(snapshot.complete);
    assert_eq!(snapshot.reason, "observed");
    assert_eq!(snapshot.bucket, BucketSource::Legacy);
    assert_eq!(snapshot.windows.len(), 2);
    let mut named = full();
    named["result"]["rateLimitsByLimitId"] = json!({"codex":{"primary":{"usedPercent":90,"windowDurationMins":300,"resetsAt":4500},"secondary":{"usedPercent":80,"windowDurationMins":10080,"resetsAt":8500}},"other":{"primary":null}});
    let snapshot = parse_snapshot(&named).unwrap();
    assert_eq!(snapshot.bucket, BucketSource::NamedCodex);
    assert_eq!(snapshot.windows[0].used_percent, 90);
    assert_eq!(snapshot.account_id.as_deref(), Some("reader-workspace"));
}

#[test]
fn absent_and_null_capacity_fields_are_unknown_and_denial_has_priority() {
    for null in [false, true] {
        let mut value = full();
        if null {
            value["result"]["ordinaryUsageAllowed"] = Value::Null;
        } else {
            value["result"]
                .as_object_mut()
                .unwrap()
                .remove("ordinaryUsageAllowed");
        }
        let snapshot = parse_snapshot(&value).unwrap();
        assert!(snapshot.complete);
        assert_eq!(snapshot.ordinary_usage_allowed, None);
        assert_eq!(snapshot.reason, "backend_permission_unavailable");
    }
    let mut value = full();
    value["result"]["accountId"] = Value::Null;
    assert_eq!(
        parse_snapshot(&value).unwrap().reason,
        "account_identity_unavailable"
    );
    value["result"]["ordinaryUsageAllowed"] = json!(false);
    value["result"]["rateLimits"]["secondary"] = Value::Null;
    let snapshot = parse_snapshot(&value).unwrap();
    assert_eq!(snapshot.reason, "backend_denied");
    assert!(!snapshot.complete);
}

#[test]
fn sparse_windows_remain_distinct_and_never_refresh_a_full_snapshot() {
    let mut value = full();
    value["result"]["rateLimits"]
        .as_object_mut()
        .unwrap()
        .remove("secondary");
    let missing = parse_snapshot(&value).unwrap();
    assert_eq!(missing.completeness.secondary, WindowState::Missing);
    assert!(!missing.complete);
    value["result"]["rateLimits"]["secondary"] = Value::Null;
    assert_eq!(
        parse_snapshot(&value).unwrap().completeness.secondary,
        WindowState::Null
    );
    value["result"]["rateLimits"]["secondary"] = json!({"usedPercent":20});
    let incomplete = parse_snapshot(&value).unwrap();
    assert_eq!(incomplete.completeness.secondary, WindowState::Incomplete);
    assert!(!incomplete.complete);
    assert_eq!(incomplete.windows.len(), 1);
    let notice = json!({"method":"account/rateLimits/updated","params":{"rateLimits":{"primary":{"usedPercent":1,"windowDurationMins":300,"resetsAt":9000}}}});
    assert_eq!(parse_snapshot(&notice), Err(ReadFailure::InvalidResponse));
    assert_eq!(parse_snapshot(&full()).unwrap().windows[0].used_percent, 10);
}

#[test]
fn malformed_secondary_or_metadata_invalidates_the_entire_semantic_snapshot() {
    for bad in [
        json!("bad"),
        json!({"usedPercent":101}),
        json!({"usedPercent":20,"windowDurationMins":"300"}),
        json!({"usedPercent":20,"resetsAt":1.5}),
    ] {
        let mut value = full();
        value["result"]["rateLimits"]["secondary"] = bad;
        assert_eq!(parse_snapshot(&value), Err(ReadFailure::InvalidResponse));
    }
    for (key, bad) in [
        ("ordinaryUsageAllowed", json!("true")),
        ("accountId", json!(true)),
        ("accountId", json!("")),
        ("accountId", json!("private\nidentity")),
    ] {
        let mut value = full();
        value["result"][key] = bad;
        assert_eq!(parse_snapshot(&value), Err(ReadFailure::InvalidResponse));
    }
    let mut value = full();
    value["result"]["rateLimitsByLimitId"] =
        json!({"codex":value["result"]["rateLimits"],"other":{"secondary":{"usedPercent":-1}}});
    assert_eq!(parse_snapshot(&value), Err(ReadFailure::InvalidResponse));
}

#[test]
fn past_reset_is_observed_metadata_and_explicit_restrictions_are_retained() {
    let mut value = full();
    value["result"]["rateLimits"]["primary"]["resetsAt"] = json!(1);
    value["result"]["rateLimits"]["spendControlReached"] = json!(true);
    value["result"]["rateLimits"]["rateLimitReachedType"] =
        json!("workspace_member_usage_limit_reached");
    let snapshot = parse_snapshot(&value).unwrap();
    assert!(snapshot.complete);
    assert_eq!(snapshot.windows[0].resets_at, Some(1));
    assert_eq!(snapshot.spend_control_reached, Some(true));
    assert!(snapshot.rate_limit_reached);
}

#[test]
fn freshness_uses_read_start_and_rejects_failure_or_reversed_elapsed_evidence() {
    let mut observation = CodexObservation {
        started_at_ms: 1000,
        finished_at_ms: 2000,
        started_elapsed_ms: 100,
        finished_elapsed_ms: 1100,
        context: None,
        outcome: ReadOutcome::Snapshot(parse_snapshot(&full()).unwrap()),
    };
    assert!(observation.fresh_at(180_100, 180_000));
    assert!(!observation.fresh_at(180_101, 180_000));
    observation.finished_at_ms = 1;
    assert!(
        observation.fresh_at(180_100, 180_000),
        "wall rollback cannot extend or reset monotonic freshness"
    );
    assert!(!observation.fresh_at(1099, 180_000));
    observation.outcome = ReadOutcome::Failure(ReadFailure::ProviderError);
    assert!(!observation.fresh_at(1100, 180_000));
    observation.outcome = ReadOutcome::Snapshot(parse_snapshot(&full()).unwrap());
    observation.finished_elapsed_ms = 99;
    assert!(!observation.fresh_at(1100, 180_000));
}

#[test]
fn context_fingerprint_binds_only_executable_arguments_cwd_and_reported_home() {
    let home = std::env::temp_dir();
    let command = (home.join("codex"), vec![OsString::from("literal arg")]);
    let initialized = json!({"id":1,"result":{"codexHome":home.to_str().unwrap()}});
    let first = reader_context(&command, &home, &initialized)
        .unwrap()
        .unwrap();
    assert_eq!(first.context_id.len(), 64);
    assert_eq!(
        reader_context(&command, &home, &initialized)
            .unwrap()
            .unwrap(),
        first
    );
    assert_ne!(
        reader_context(&command, &home.join("other"), &initialized)
            .unwrap()
            .unwrap()
            .context_id,
        first.context_id
    );
    let other = (command.0.clone(), vec![OsString::from("other arg")]);
    assert_ne!(
        reader_context(&other, &home, &initialized)
            .unwrap()
            .unwrap()
            .context_id,
        first.context_id
    );
    assert_eq!(
        reader_context(&command, &home, &json!({"result":{}})).unwrap(),
        None
    );
    assert_eq!(
        reader_context(&command, &home, &json!({"result":{"codexHome":"relative"}})),
        Err(ReadFailure::ContextUnavailable)
    );
}

#[tokio::test]
async fn bounded_frames_ignore_notifications_and_matching_errors_never_expose_payloads() {
    let bytes = b"{\"method\":\"account/rateLimits/updated\",\"params\":{}}\n{\"id\":2,\"result\":{\"rateLimits\":{}}}\n";
    let mut frames = Frames::new(&bytes[..]);
    assert!(frames.response(2).await.is_ok());
    let bytes = b"{\"id\":2,\"error\":{\"message\":\"private provider content\"}}\n";
    let failure = Frames::new(&bytes[..]).response(2).await.unwrap_err();
    assert_eq!(failure, ReadFailure::ProviderError);
    assert_eq!(failure.code(), "provider_error");
    assert_eq!(format!("{failure:?}"), "ProviderError");
}

#[tokio::test]
async fn bounded_frames_reject_line_total_frame_and_truncated_limits() {
    let mut bytes = vec![b' '; MAX_LINE + 1];
    bytes.push(b'\n');
    assert_eq!(
        Frames::new(bytes.as_slice()).next().await,
        Err(ReadFailure::InvalidResponse)
    );
    assert_eq!(
        Frames::new(&b"{}"[..]).next().await,
        Err(ReadFailure::InvalidResponse)
    );
    let bytes = b"{}\n".repeat(MAX_FRAMES + 1);
    assert_eq!(
        Frames::new(bytes.as_slice()).response(2).await,
        Err(ReadFailure::InvalidResponse)
    );
    let line = format!("{{\"padding\":\"{}\"}}\n", "x".repeat(MAX_LINE - 20));
    let bytes = line.repeat(5);
    assert_eq!(
        Frames::new(bytes.as_bytes()).response(2).await,
        Err(ReadFailure::InvalidResponse)
    );
}

#[test]
fn claude_diagnostics_keep_source_time_and_do_not_renew_it_when_polled() {
    let value = json!({"at":1000,"rate_limits":{"five_hour":{"used_percentage":88.2,"resets_at":4000},"seven_day":{"used_percentage":10,"resets_at":8000}}});
    let first = crate::usage::parse_claude_observation(&value, 1_100_000);
    let second = crate::usage::parse_claude_observation(&value, 1_200_000);
    assert_eq!(first.source_at_ms, Some(1_000_000));
    assert_eq!(second.source_at_ms, first.source_at_ms);
    assert_ne!(first.observed_at_ms, second.observed_at_ms);
    assert_eq!(first.reason, "observed");
    assert_eq!(
        crate::usage::parse_claude_observation(&value, 2_000_000).reason,
        "stale_cache"
    );
    assert!(
        crate::usage::parse_claude_observation(&value, 2_000_000)
            .windows
            .is_empty()
    );
    assert_eq!(
        crate::usage::parse_claude_observation(&value, 900_000).reason,
        "future_cache"
    );
    assert_eq!(
        crate::usage::parse_claude_observation(&json!({}), 1_100_000).reason,
        "invalid_cache"
    );
    let mut expired = value;
    expired["rate_limits"]["five_hour"]["resets_at"] = json!(1001);
    expired["rate_limits"]["seven_day"]["resets_at"] = json!(1001);
    assert_eq!(
        crate::usage::parse_claude_observation(&expired, 1_100_000).reason,
        "windows_unavailable"
    );
}

struct ClaudeCacheFixture {
    directory: PathBuf,
    path: PathBuf,
}

impl ClaudeCacheFixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "nesvo-claude-cache-{}",
            hex::encode(nesvo_wire::random::<16>())
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join(".rate-limits.json");
        Self { directory, path }
    }
}

impl Drop for ClaudeCacheFixture {
    fn drop(&mut self) {
        // Remove only the known paths created by this fixture, including a FIFO or
        // final symlink without traversing it.
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_dir(&self.path);
        let _ = std::fs::remove_file(self.directory.join("target.json"));
        let _ = std::fs::remove_dir(&self.directory);
    }
}

#[tokio::test]
async fn claude_regular_cache_keeps_original_source_and_rejects_invalid_or_oversized_data() {
    let fixture = ClaudeCacheFixture::new();
    let value = json!({"at":1000,"rate_limits":{"five_hour":{"used_percentage":88.2,"resets_at":4000},"seven_day":{"used_percentage":10,"resets_at":8000}}});
    std::fs::write(&fixture.path, serde_json::to_vec(&value).unwrap()).unwrap();
    let observed = crate::usage::read_claude_cache(&fixture.path, 1_100_000).await;
    assert_eq!(observed.reason, "observed");
    assert_eq!(observed.source_at_ms, Some(1_000_000));
    assert_eq!(observed.observed_at_ms, 1_100_000);
    assert_eq!(observed.windows.len(), 2);

    std::fs::write(&fixture.path, b"private malformed cache").unwrap();
    let invalid = crate::usage::read_claude_cache(&fixture.path, 1_200_000).await;
    assert_eq!(invalid.reason, "invalid_cache");
    assert_eq!(invalid.source_at_ms, None);
    assert!(invalid.windows.is_empty());

    std::fs::write(&fixture.path, vec![b' '; 16_385]).unwrap();
    let oversized = crate::usage::read_claude_cache(&fixture.path, 1_300_000).await;
    assert_eq!(oversized.reason, "cache_oversized");
    assert_eq!(oversized.source_at_ms, None);
    assert!(oversized.windows.is_empty());
}

#[tokio::test]
async fn claude_directory_cache_is_refused_before_open() {
    let fixture = ClaudeCacheFixture::new();
    std::fs::create_dir(&fixture.path).unwrap();
    let observation = crate::usage::read_claude_cache(&fixture.path, 1_100_000).await;
    assert_eq!(observation.reason, "cache_non_regular");
    assert_eq!(observation.source_at_ms, None);
    assert!(observation.windows.is_empty());
}

#[tokio::test]
async fn claude_stalled_cache_read_has_a_deadline_without_fabricating_source_time() {
    use tokio::io::AsyncWriteExt;

    let (reader, mut writer) = tokio::io::duplex(128);
    writer.write_all(b"{\"at\":1000}").await.unwrap();
    // Keep the writer open: a complete JSON prefix is not a completed file read.
    let observation = crate::usage::observe_claude_cache(
        1_100_000,
        crate::usage::read_claude_cache_bytes(reader),
        Duration::from_millis(5),
    )
    .await;
    assert_eq!(observation.reason, "cache_timeout");
    assert_eq!(observation.observed_at_ms, 1_100_000);
    assert_eq!(observation.source_at_ms, None);
    assert!(observation.windows.is_empty());
    assert!(writer.write_all(b" ").await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn claude_fifo_is_refused_and_a_swapped_fifo_cannot_block_open() {
    use std::os::unix::ffi::OsStrExt;

    let fixture = ClaudeCacheFixture::new();
    let path = std::ffi::CString::new(fixture.path.as_os_str().as_bytes()).unwrap();
    // SAFETY: path is NUL-terminated and valid for the duration of this call.
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    let observation = crate::usage::read_claude_cache(&fixture.path, 1_100_000).await;
    assert_eq!(observation.reason, "cache_non_regular");
    assert_eq!(observation.source_at_ms, None);
    assert!(observation.windows.is_empty());

    // Bypass the preliminary path check to exercise replacement between stat and
    // open. No FIFO writer exists; the nonblocking open must still finish.
    let opened = tokio::time::timeout(
        Duration::from_secs(1),
        crate::usage::open_claude_cache(&fixture.path),
    )
    .await
    .expect("opening a replacement FIFO must not block");
    assert!(matches!(
        opened,
        Err(crate::usage::ClaudeCacheFailure::NonRegular)
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn claude_final_symlink_is_refused_even_if_swapped_after_metadata() {
    let fixture = ClaudeCacheFixture::new();
    let target = fixture.directory.join("target.json");
    let contents = b"{\"at\":1000}";
    std::fs::write(&target, contents).unwrap();
    std::os::unix::fs::symlink(&target, &fixture.path).unwrap();
    let observation = crate::usage::read_claude_cache(&fixture.path, 1_100_000).await;
    assert_eq!(observation.reason, "cache_non_regular");
    assert!(
        crate::usage::open_claude_cache(&fixture.path)
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(target).unwrap(), contents);
}
