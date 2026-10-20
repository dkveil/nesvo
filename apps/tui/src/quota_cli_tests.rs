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
