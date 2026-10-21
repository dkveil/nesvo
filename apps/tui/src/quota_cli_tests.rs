use super::*;
use clap::Parser;

#[test]
fn quota_directory_selector_is_explicit_codex_intent_and_rejects_invalid_combinations() {
    let parsed = crate::Arguments::try_parse_from([
        "nesvo",
        "quota",
        "--program",
        "codex",
        "--directory",
        "C:\\work\\project",
        "--refresh",
        "--json",
    ])
    .unwrap();
    let Command::Quota {
        program,
        directory,
        refresh,
        ..
    } = parsed.command.unwrap()
    else {
        panic!("quota command expected");
    };
    assert_eq!(
        provider_quota_context_query(program.as_deref(), refresh, directory.as_deref()).unwrap(),
        json!({"type":"getProviderQuota","program":"codex","refresh":true,"directory":"C:\\work\\project"})
    );
    for program in [None, Some("claude"), Some("gemini")] {
        assert!(provider_quota_context_query(program, false, Some("C:\\work")).is_err());
    }
    assert!(provider_quota_context_query(Some("codex"), false, Some("bad\npath")).is_err());
    assert!(
        crate::Arguments::try_parse_from(["nesvo", "quota", "--directory", "C:\\work"]).is_err()
    );
}

#[test]
fn quota_cli_builds_the_shared_observation_and_explicit_refresh_requests() {
    let parsed = crate::Arguments::try_parse_from(["nesvo", "quota", "--json"]).unwrap();
    let Command::Quota {
        program,
        refresh,
        json,
        ..
    } = parsed.command.unwrap()
    else {
        panic!("quota command expected");
    };
    assert!(json);
    assert_eq!(
        provider_quota_query(program.as_deref(), refresh).unwrap(),
        json!({"type":"getProviderQuota","refresh":false})
    );
    let parsed =
        crate::Arguments::try_parse_from(["nesvo", "quota", "--program", "codex", "--refresh"])
            .unwrap();
    let Command::Quota {
        program, refresh, ..
    } = parsed.command.unwrap()
    else {
        panic!("quota command expected");
    };
    assert_eq!(
        provider_quota_query(program.as_deref(), refresh).unwrap(),
        json!({"type":"getProviderQuota","program":"codex","refresh":true})
    );
    assert!(crate::Arguments::try_parse_from(["nesvo", "quota", "--refresh"]).is_err());
    assert!(crate::Arguments::try_parse_from(["nesvo", "quota", "--program", "shell"]).is_err());
    assert!(provider_quota_query(None, true).is_err());
    assert!(provider_quota_query(Some("Codex"), false).is_err());
}

#[test]
fn quota_capability_is_explicit_and_never_inferred_from_display_or_wake_support() {
    for caps in [
        json!({}),
        json!({"providerLimits":[],"quotaWake":true}),
        json!({"providerQuotaObservations":false}),
        json!({"providerQuotaObservations":"true"}),
        json!({"providerQuotaObservations":1}),
    ] {
        let error = check_provider_quota_capability(&caps).unwrap_err();
        assert_eq!(error_value(&error)["error"]["code"], "unsupported");
    }
    check_provider_quota_capability(&json!({"providerQuotaObservations":true})).unwrap();
}

#[test]
fn quota_human_output_keeps_refresh_progress_separate_from_observation_evidence() {
    let base = json!({"type":"providerQuota","providers":[{"program":"codex","source":"codexAppServer","revision":8,"status":"unavailable","reason":"incomplete_snapshot","observedAt":1000,"ageMs":6000,"freshness":"stale","complete":false,"ordinaryUsageAllowed":null,"windows":[]}],"refresh":{"program":"codex","state":"pending","revision":8,"retryAfterMs":0}});
    let text = provider_quota_text(&base);
    assert!(text.contains("codex pending"));
    assert!(text.contains("already in progress"));
    assert!(text.contains("last-known (stale), partial"));
    assert!(text.contains("backend permission unavailable"));
    let mut queued = base.clone();
    queued["refresh"]["state"] = "queued".into();
    assert!(provider_quota_text(&queued).contains("accepted; inspect a later revision"));
    let mut cooldown = base.clone();
    cooldown["refresh"]["state"] = "cooldown".into();
    cooldown["refresh"]["retryAfterMs"] = 1200.into();
    assert!(provider_quota_text(&cooldown).contains("cooldown"));
    assert!(provider_quota_text(&cooldown).contains("retry after 1200 ms"));
    let mut fresh = base;
    fresh["providers"][0]["freshness"] = "fresh".into();
    fresh["providers"][0]["complete"] = true.into();
    fresh["providers"][0]["ordinaryUsageAllowed"] = true.into();
    let text = provider_quota_text(&fresh);
    assert!(text.contains("fresh, complete"));
    assert!(text.contains("native account binding is unverified"));
}

#[test]
fn quota_human_output_lists_gate_verdicts_and_the_hold_queue() {
    let held = json!({"type":"providerQuota","providers":[],"refresh":null,"gate":{"revision":4,"providers":[
        {"program":"claude","source":"claudeStatusline","verdict":"hold","reason":"quota_exhausted","resetsAt":1_792_629_000_000_u64,"freshUntil":null},
        {"program":"gemini","source":"unsupported","verdict":"unknown","reason":"no_admission_source","resetsAt":null,"freshUntil":null}
    ],"holds":[{"id":"0123456789abcdef0123456789abcdef","kind":"launch","program":"claude","reason":"quota_exhausted","resetsAt":1_792_629_000_000_u64,"since":1_792_613_681_000_u64,"checks":2}]}});
    let text = provider_quota_text(&held);
    assert!(text.contains("Launch gate:"));
    assert!(text.contains(
        "  claude: hold · quota_exhausted · source claudeStatusline · resets at 1792629000000 ms"
    ));
    assert!(text.contains("  gemini: unknown · no_admission_source · source unsupported"));
    assert!(text.contains(
        "  Held launch 0123456789abcdef0123456789abcdef · claude · quota_exhausted · resets at 1792629000000 ms · checks 2"
    ));
    let mut clear = held;
    clear["gate"]["holds"] = json!([]);
    assert!(provider_quota_text(&clear).contains("  No held launches."));
}
