use super::*;

fn context_from_initializer(
    command: &(PathBuf, Vec<OsString>),
    cwd: &Path,
    initialized: &Value,
) -> Result<Option<ReaderContext>, ReadFailure> {
    reader_context(
        command,
        cwd,
        initialized,
        None,
        RouteObservation::unknown("route_metadata_unavailable"),
    )
}

fn chatgpt_account() -> Result<Value, ReadFailure> {
    Ok(
        json!({"id":2,"result":{"requiresOpenaiAuth":true,"account":{"type":"chatgpt","email":"private@example.invalid","planType":"plus"}}}),
    )
}

fn openai_configuration() -> Result<Value, ReadFailure> {
    Ok(
        json!({"id":3,"result":{"config":{"model_provider":"openai","model":"native-model","forced_login_method":"chatgpt"},"origins":{"model_provider":{"name":{"type":"user","file":"private-config-path"},"version":"version-1"}}}}),
    )
}

fn configured_route() -> RouteObservation {
    parse_route(
        &chatgpt_account(),
        &openai_configuration(),
        RouteEnvironment::default(),
    )
}

#[test]
fn configured_chatgpt_openai_route_accepts_only_supported_nonoverridden_metadata() {
    let route = configured_route();
    assert_eq!(route.verdict, RouteVerdict::ChatgptConfiguredOpenai);
    assert_eq!(route.reason, "route_chatgpt_configured_openai");
    assert_eq!(route.config_fingerprint.as_ref().unwrap().len(), 64);
    let mut config = openai_configuration().unwrap();
    config["result"]["config"]["model_provider"] = Value::Null;
    config["result"]["config"]["model_providers"] =
        json!({"unused":{"base_url":"https://unused.invalid","env_key":"PRIVATE_KEY_NAME"}});
    assert_eq!(
        parse_route(&chatgpt_account(), &Ok(config), RouteEnvironment::default()).verdict,
        RouteVerdict::ChatgptConfiguredOpenai
    );
}

#[test]
fn custom_provider_endpoints_oss_and_forced_api_never_grant_chatgpt_route() {
    for (field, value, expected) in [
        ("model_provider", json!("custom"), RouteVerdict::Custom),
        (
            "model_providers",
            json!({"openai":{}}),
            RouteVerdict::Custom,
        ),
        (
            "openai_base_url",
            json!("https://api.openai.com/v1"),
            RouteVerdict::Custom,
        ),
        (
            "chatgpt_base_url",
            json!("https://custom.invalid/backend-api"),
            RouteVerdict::Custom,
        ),
        ("oss", json!(true), RouteVerdict::Custom),
        ("local_provider", json!("ollama"), RouteVerdict::Custom),
        ("forced_login_method", json!("api"), RouteVerdict::ApiKey),
        (
            "auth_mode",
            json!("amazonBedrock"),
            RouteVerdict::AmazonBedrock,
        ),
        ("auth_mode", json!("unknown-mode"), RouteVerdict::Unknown),
        ("model_providers", json!(false), RouteVerdict::Unknown),
        ("model_provider", json!(5), RouteVerdict::Unknown),
    ] {
        let mut config = openai_configuration().unwrap();
        config["result"]["config"][field] = value;
        assert_eq!(
            parse_route(&chatgpt_account(), &Ok(config), RouteEnvironment::default()).verdict,
            expected,
            "{field}"
        );
    }
    for environment in [
        RouteEnvironment {
            openai_base_url: true,
            api_key: false,
        },
        RouteEnvironment {
            openai_base_url: false,
            api_key: true,
        },
    ] {
        assert_ne!(
            parse_route(&chatgpt_account(), &openai_configuration(), environment).verdict,
            RouteVerdict::ChatgptConfiguredOpenai
        );
    }
}

#[test]
fn missing_invalid_or_failed_account_and_configuration_cannot_grant_route() {
    for (kind, expected) in [
        ("apiKey", RouteVerdict::ApiKey),
        ("amazonBedrock", RouteVerdict::AmazonBedrock),
        ("futureAuth", RouteVerdict::Unknown),
    ] {
        let account = Ok(json!({"result":{"requiresOpenaiAuth":true,"account":{"type":kind}}}));
        assert_eq!(
            parse_route(
                &account,
                &openai_configuration(),
                RouteEnvironment::default()
            )
            .verdict,
            expected
        );
    }
    for account in [
        Err(ReadFailure::ProviderError),
        Ok(json!({"result":{"requiresOpenaiAuth":true,"account":null}})),
        Ok(json!({"result":{"requiresOpenaiAuth":false,"account":{"type":"chatgpt"}}})),
        Ok(json!({"result":{"account":{"type":"chatgpt"}}})),
    ] {
        assert_eq!(
            parse_route(
                &account,
                &openai_configuration(),
                RouteEnvironment::default()
            )
            .verdict,
            RouteVerdict::Unknown
        );
    }
    for config in [
        Err(ReadFailure::ProviderError),
        Ok(json!({"result":{"config":{},"origins":null}})),
        Ok(json!({"result":null})),
    ] {
        let route = parse_route(&chatgpt_account(), &config, RouteEnvironment::default());
        assert_eq!(route.verdict, RouteVerdict::Unknown);
        assert_eq!(route.config_fingerprint, None);
    }
}

#[test]
fn route_and_context_hash_bind_config_version_and_reader_version_without_secret_fields() {
    let original = configured_route();
    let mut config = openai_configuration().unwrap();
    config["result"]["origins"]["model_provider"]["version"] = json!("version-2");
    let updated = parse_route(&chatgpt_account(), &Ok(config), RouteEnvironment::default());
    assert_ne!(original.config_fingerprint, updated.config_fingerprint);

    let home = std::env::temp_dir();
    let command = (home.join("codex"), vec![]);
    let initialized =
        json!({"result":{"codexHome":home.to_str().unwrap(),"userAgent":"codex/0.156.0"}});
    let context = reader_context(&command, &home, &initialized, Some(&home), original.clone())
        .unwrap()
        .unwrap();
    assert_eq!(context.route.verdict, RouteVerdict::ChatgptConfiguredOpenai);
    assert_ne!(
        context.context_id,
        reader_context(&command, &home, &initialized, Some(&home), updated)
            .unwrap()
            .unwrap()
            .context_id
    );
    let mut next_version = initialized.clone();
    next_version["result"]["userAgent"] = json!("codex/next");
    assert_ne!(
        context.context_id,
        reader_context(
            &command,
            &home,
            &next_version,
            Some(&home),
            original.clone()
        )
        .unwrap()
        .unwrap()
        .context_id
    );
    next_version["result"]
        .as_object_mut()
        .unwrap()
        .remove("userAgent");
    let old = reader_context(
        &command,
        &home,
        &next_version,
        Some(&home),
        original.clone(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(old.route.verdict, RouteVerdict::Unknown);
    assert_eq!(old.route.reason, "route_reader_version_unavailable");

    let mut account = chatgpt_account().unwrap();
    account["result"]["account"]["email"] = json!("another-private-email@example.invalid");
    let mut config = openai_configuration().unwrap();
    config["result"]["config"]["model_providers"] = json!({"unused":{"headers":{"Authorization":"private-secret"},"base_url":"https://private.invalid"}});
    config["result"]["config"]["instructions"] = json!("private prompt");
    assert_eq!(
        parse_route(&Ok(account), &Ok(config), RouteEnvironment::default()).config_fingerprint,
        original.config_fingerprint
    );
}

#[test]
fn explicit_home_must_match_reported_home_after_lexical_normalization() {
    let home = std::env::temp_dir();
    let command = (home.join("codex"), vec![]);
    let initialized = json!({"result":{"codexHome":home.join("nested").join("..").to_str().unwrap(),"userAgent":"codex/0.156.0"}});
    assert!(
        reader_context(
            &command,
            &home,
            &initialized,
            Some(&home),
            configured_route()
        )
        .unwrap()
        .is_some()
    );
    assert_eq!(
        reader_context(
            &command,
            &home,
            &initialized,
            Some(&home.join("other")),
            configured_route()
        ),
        Err(ReadFailure::ContextUnavailable)
    );
    assert_eq!(
        normalized_context_path(Path::new("relative-home")),
        Err(ReadFailure::ContextUnavailable)
    );
}

#[test]
fn quota_received_before_metadata_timeout_stays_displayable_without_route_authority() {
    let home = std::env::temp_dir();
    let command = (home.join("codex"), vec![]);
    let initialized =
        json!({"result":{"codexHome":home.to_str().unwrap(),"userAgent":"codex/0.156.0"}});
    let mut context = reader_context(
        &command,
        &home,
        &initialized,
        Some(&home),
        configured_route(),
    )
    .unwrap();
    let previous_id = context.as_ref().unwrap().context_id.clone();
    let outcome = read_outcome(
        Err(ReadFailure::Timeout),
        Some(parse_snapshot(&full()).unwrap()),
        &mut context,
    );
    assert!(
        matches!(outcome, ReadOutcome::Snapshot(snapshot) if snapshot.complete && snapshot.windows.len() == 2)
    );
    let context = context.unwrap();
    assert_eq!(context.route.verdict, RouteVerdict::Unknown);
    assert_eq!(context.route.config_fingerprint, None);
    assert_ne!(context.context_id, previous_id);
    assert_eq!(
        read_outcome(Err(ReadFailure::Timeout), None, &mut None),
        ReadOutcome::Failure(ReadFailure::Timeout)
    );
}

async fn route_rpc_fixture(
    account: Value,
    config: Value,
) -> (ReaderContext, CodexSnapshot, Vec<Value>) {
    let home = std::env::temp_dir();
    let command = (home.join("codex"), vec![]);
    let requested = ReadContext {
        command: &command,
        cwd: &home,
        home: Some(&home),
        environment: RouteEnvironment::default(),
    };
    let initialized =
        json!({"id":1,"result":{"codexHome":home.to_str().unwrap(),"userAgent":"codex/0.156.0"}});
    let (client, server) = tokio::io::duplex(8192);
    let (input, output) = tokio::io::split(client);
    let (server_input, mut server_output) = tokio::io::split(server);
    let mut context = None;
    let mut snapshot = None;
    let adapter = rpc_io(output, input, &requested, &mut context, &mut snapshot);
    let fixture = async {
        let mut reader = BufReader::new(server_input);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let mut requests = vec![serde_json::from_str::<Value>(&line).unwrap()];
        server_output
            .write_all(format!("{initialized}\n").as_bytes())
            .await
            .unwrap();
        server_output.flush().await.unwrap();
        for _ in 0..4 {
            line.clear();
            reader.read_line(&mut line).await.unwrap();
            requests.push(serde_json::from_str::<Value>(&line).unwrap());
        }
        let mut quota = full();
        quota["id"] = json!(4);
        for response in [quota, config, account] {
            server_output
                .write_all(format!("{response}\n").as_bytes())
                .await
                .unwrap();
        }
        server_output.flush().await.unwrap();
        requests
    };
    let (result, requests) = tokio::time::timeout(Duration::from_secs(2), async {
        tokio::join!(adapter, fixture)
    })
    .await
    .unwrap();
    result.unwrap();
    (context.unwrap(), snapshot.unwrap(), requests)
}

#[tokio::test]
async fn same_reader_requests_only_bounded_readonly_metadata_and_preserves_quota_on_rpc_error() {
    let (context, snapshot, requests) =
        route_rpc_fixture(chatgpt_account().unwrap(), openai_configuration().unwrap()).await;
    assert_eq!(context.route.verdict, RouteVerdict::ChatgptConfiguredOpenai);
    assert!(snapshot.complete);
    assert_eq!(requests.len(), 5);
    assert_eq!(requests[1], json!({"method":"initialized","params":{}}));
    assert_eq!(
        requests[2],
        json!({"id":2,"method":"account/read","params":{"refreshToken":false}})
    );
    assert_eq!(
        requests[3],
        json!({"id":3,"method":"config/read","params":{"cwd":std::env::temp_dir().to_str().unwrap(),"includeLayers":false}})
    );
    assert_eq!(
        requests[4],
        json!({"id":4,"method":"account/rateLimits/read","params":{}})
    );
    for (account, config) in [
        (
            json!({"id":2,"error":{"message":"private account failure"}}),
            openai_configuration().unwrap(),
        ),
        (
            chatgpt_account().unwrap(),
            json!({"id":3,"error":{"message":"private config failure"}}),
        ),
    ] {
        let (context, snapshot, _) = route_rpc_fixture(account, config).await;
        assert_eq!(context.route.verdict, RouteVerdict::Unknown);
        assert_eq!(snapshot.windows.len(), 2);
        assert!(snapshot.complete);
        assert!(!format!("{:?}", context.route).contains("private"));
    }
}

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
    assert!(snapshot.complete);
}

#[test]
fn optional_windows_remain_distinct_and_notifications_never_become_full_reads() {
    let mut value = full();
    value["result"]["rateLimits"]
        .as_object_mut()
        .unwrap()
        .remove("secondary");
    let missing = parse_snapshot(&value).unwrap();
    assert_eq!(missing.completeness.secondary, WindowState::Missing);
    assert!(missing.complete);
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
fn full_reads_accept_zero_one_or_two_advertised_windows_without_inventing_capacity() {
    for primary in [
        WindowState::Missing,
        WindowState::Null,
        WindowState::Complete,
    ] {
        for secondary in [
            WindowState::Missing,
            WindowState::Null,
            WindowState::Complete,
        ] {
            let mut value = full();
            for (key, state) in [("primary", primary), ("secondary", secondary)] {
                match state {
                    WindowState::Missing => {
                        value["result"]["rateLimits"]
                            .as_object_mut()
                            .unwrap()
                            .remove(key);
                    }
                    WindowState::Null => value["result"]["rateLimits"][key] = Value::Null,
                    _ => {}
                }
            }
            let sample = parse_snapshot(&value).unwrap();
            assert_eq!(
                sample.completeness,
                BucketCompleteness { primary, secondary }
            );
            assert!(sample.complete);
            assert_eq!(sample.reason, "observed");
            assert_eq!(sample.ordinary_usage_allowed, Some(true));
            assert_eq!(
                sample.completeness.complete_window_count(),
                Some(sample.windows.len())
            );
            assert!(sample.windows.iter().all(|window| window.used_percent > 0));
            value["result"]["ordinaryUsageAllowed"] = Value::Null;
            let unknown = parse_snapshot(&value).unwrap();
            assert!(unknown.complete);
            assert_eq!(unknown.ordinary_usage_allowed, None);
            assert_eq!(unknown.reason, "backend_permission_unavailable");
        }
    }
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
    let first = context_from_initializer(&command, &home, &initialized)
        .unwrap()
        .unwrap();
    assert_eq!(first.context_id.len(), 64);
    assert_eq!(
        context_from_initializer(&command, &home, &initialized)
            .unwrap()
            .unwrap(),
        first
    );
    assert_ne!(
        context_from_initializer(&command, &home.join("other"), &initialized)
            .unwrap()
            .unwrap()
            .context_id,
        first.context_id
    );
    let other = (command.0.clone(), vec![OsString::from("other arg")]);
    assert_ne!(
        context_from_initializer(&other, &home, &initialized)
            .unwrap()
            .unwrap()
            .context_id,
        first.context_id
    );
    assert_eq!(
        context_from_initializer(&command, &home, &json!({"result":{}})).unwrap(),
        None
    );
    assert_eq!(
        context_from_initializer(&command, &home, &json!({"result":{"codexHome":"relative"}})),
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
