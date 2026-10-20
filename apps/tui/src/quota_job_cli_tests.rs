//! Shared owner CLI/MCP quota-job payloads; no host, provider or model activity.
use super::*;
use clap::Parser;

fn binding(letter: char) -> String {
    letter.to_string().repeat(64)
}
fn authorization() -> Value {
    json!({"key":"quota-binding-once","jobId":"job-id","occurrenceId":"occurrence-id",
        "expectedContextId":binding('a'),"expectedAccountFingerprint":binding('b'),
        "contextId":binding('c'),"accountFingerprint":binding('d')})
}
fn policy() -> Value {
    json!({"mode":"wait","contextId":binding('c'),"accountFingerprint":binding('d')})
}
fn spec() -> Value {
    json!({"title":"Configured quota admission","instruction":"Keep the original task",
        "profile":{"program":"codex","workspace":"shared"},
        "schedule":{"kind":"once","at":"2026-12-01T00:00:00Z"}})
}
fn cli(args: Vec<String>) -> Value {
    let parsed = crate::Arguments::try_parse_from(args).unwrap();
    let crate::cli::Command::Job { command } = parsed.command.unwrap() else {
        panic!("job command expected");
    };
    assert!(command.machine());
    crate::workflow::tool("jobs", json!({"request":command.request().unwrap()})).unwrap()
}

#[test]
fn quota_authorization_cli_and_mcp_send_the_same_exact_old_and_new_binding() {
    let cli = cli(vec![
        "nesvo".into(),
        "job".into(),
        "authorize-quota".into(),
        "job-id".into(),
        "occurrence-id".into(),
        "--key".into(),
        "quota-binding-once".into(),
        "--expected-context".into(),
        binding('a'),
        "--expected-account".into(),
        binding('b'),
        "--context".into(),
        binding('c'),
        "--account".into(),
        binding('d'),
        "--json".into(),
    ]);
    let (mcp, kind) = command("nesvo_authorize_job_quota", authorization()).unwrap();
    assert_eq!(kind, "workflow");
    assert_eq!(cli, mcp);
    let mut expected = authorization();
    expected["action"] = json!("authorizeQuota");
    assert_eq!(mcp["request"]["request"], expected);
    assert_eq!(
        command("nesvo_authorize_job_quota", authorization())
            .unwrap()
            .0,
        mcp,
        "Reusing an exact mutation intent must not rewrite its identity fields"
    );
}

#[test]
fn quota_authorization_rejects_missing_untyped_and_overridden_fields() {
    for field in [
        "key",
        "jobId",
        "occurrenceId",
        "expectedContextId",
        "expectedAccountFingerprint",
        "contextId",
        "accountFingerprint",
    ] {
        let mut missing = authorization();
        missing.as_object_mut().unwrap().remove(field);
        assert!(
            command("nesvo_authorize_job_quota", missing).is_err(),
            "Missing {field}"
        );
    }
    for field in [
        "expectedContextId",
        "expectedAccountFingerprint",
        "contextId",
        "accountFingerprint",
    ] {
        for invalid in [
            json!("A".repeat(64)),
            json!("a".repeat(63)),
            json!("g".repeat(64)),
            json!(true),
            Value::Null,
        ] {
            let mut arguments = authorization();
            arguments[field] = invalid;
            assert!(
                command("nesvo_authorize_job_quota", arguments).is_err(),
                "Invalid {field}"
            );
        }
    }
    for (field, value) in [
        ("action", json!("runNow")),
        ("expectedRevision", json!(1)),
        ("nativePermit", json!(true)),
    ] {
        let mut arguments = authorization();
        arguments[field] = value;
        assert!(command("nesvo_authorize_job_quota", arguments).is_err());
    }
    assert!(
        crate::Arguments::try_parse_from([
            "nesvo",
            "job",
            "authorize-quota",
            "j",
            "o",
            "--key",
            "k",
            "--expected-context",
            "invalid",
            "--expected-account",
            &binding('b'),
            "--context",
            &binding('c'),
            "--account",
            &binding('d'),
        ])
        .is_err()
    );
    let schema = serde_json::to_value(
        catalog()
            .into_iter()
            .find(|tool| tool.name == "nesvo_authorize_job_quota")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(schema["inputSchema"]["additionalProperties"], false);
    assert_eq!(
        schema["inputSchema"]["required"].as_array().unwrap().len(),
        7
    );
    assert_eq!(schema["annotations"]["readOnlyHint"], false);
    assert_eq!(schema["annotations"]["idempotentHint"], true);
}

#[test]
fn quota_policy_and_authorization_require_only_the_explicit_job_quota_capability() {
    let mut selected = spec();
    selected["quotaPolicy"] = policy();
    let mut requests = vec![
        command("nesvo_authorize_job_quota", authorization())
            .unwrap()
            .0,
    ];
    for (tool, arguments) in [
        ("nesvo_create_job", json!({"key":"create","spec":selected})),
        (
            "nesvo_update_job",
            json!({"key":"edit","jobId":"j","expectedRevision":1,"spec":selected}),
        ),
    ] {
        requests.push(command(tool, arguments).unwrap().0);
    }
    for request in &requests {
        for caps in [
            json!({}),
            json!({"durableJobs":true,"providerQuotaObservations":true,"quotaWake":true}),
            json!({"jobQuotaAdmission":false}),
            json!({"jobQuotaAdmission":"true"}),
            json!({"jobQuotaAdmission":1}),
            json!({"jobQuotaAdmission":null}),
        ] {
            assert!(!crate::workflow::job_quota_supported(&caps, request));
        }
        assert!(crate::workflow::job_quota_supported(
            &json!({"jobQuotaAdmission":true}),
            request
        ));
    }
    for request in [
        command("nesvo_create_job", json!({"key":"legacy","spec":spec()}))
            .unwrap()
            .0,
        command(
            "nesvo_get_job_occurrence",
            json!({"jobId":"j","occurrenceId":"o"}),
        )
        .unwrap()
        .0,
    ] {
        assert!(crate::workflow::job_quota_supported(&json!({}), &request));
    }
    let raw = json!({"request":{"action":"jobs","request":{"action":"create","spec":{"quotaPolicy":null}}}});
    assert!(!crate::workflow::job_quota_supported(&json!({}), &raw));
}

#[test]
fn quota_policy_is_strict_and_omission_preserves_the_legacy_spec_bytes() {
    const LEGACY: &str = concat!(
        r#"{"title":"Legacy","instruction":"Report result","profile":{"name":null,"cwd":null,"program":"claude","workspace":"shared","harness":null},"#,
        r#""schedule":{"kind":"once","at":"2026-12-01T00:00:00Z"},"misfire":"catchUp","graceMs":60000,"overlap":"skip","maxElapsedMs":300000}"#
    );
    let legacy: crate::job_commands::Spec = serde_json::from_str(LEGACY).unwrap();
    assert_eq!(serde_json::to_string(&legacy).unwrap(), LEGACY);
    let mut selected = spec();
    selected["quotaPolicy"] = policy();
    for tool in ["nesvo_create_job", "nesvo_update_job"] {
        let mut arguments = json!({"key":"quota-intent","spec":selected});
        if tool == "nesvo_update_job" {
            arguments["jobId"] = json!("j");
            arguments["expectedRevision"] = json!(1);
        }
        let encoded = command(tool, arguments).unwrap().0;
        assert_eq!(
            encoded["request"]["request"]["spec"]["quotaPolicy"],
            policy()
        );
    }
    let mut invalid = vec![
        Value::Null,
        json!({}),
        json!({"mode":"skip","contextId":binding('c'),"accountFingerprint":binding('d')}),
    ];
    for (field, value) in [
        ("contextId", json!("C".repeat(64))),
        ("accountFingerprint", json!(true)),
        ("extra", json!(true)),
    ] {
        let mut bad = policy();
        bad[field] = value;
        invalid.push(bad);
    }
    for bad in invalid {
        let mut selected = spec();
        selected["quotaPolicy"] = bad;
        assert!(command("nesvo_create_job", json!({"key":"bad","spec":selected})).is_err());
    }
    assert_eq!(
        job_spec_schema()["properties"]["quotaPolicy"]["additionalProperties"],
        false
    );
}

#[test]
fn quota_file_create_and_edit_preserve_the_selected_policy_at_the_shared_boundary() {
    struct OwnedSpec(PathBuf);
    impl Drop for OwnedSpec {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let file = OwnedSpec(std::env::temp_dir().join(format!(
        "nesvo-quota-cli-{}.json",
        hex::encode(nesvo_wire::random::<8>())
    )));
    let mut selected = spec();
    selected["quotaPolicy"] = policy();
    std::fs::write(&file.0, serde_json::to_vec(&selected).unwrap()).unwrap();
    for action in ["create", "edit"] {
        let mut args = vec!["nesvo".into(), "job".into(), action.into()];
        if action == "edit" {
            args.extend(["j".into(), "--revision".into(), "1".into()]);
        }
        args.extend([
            "--key".into(),
            "file-quota".into(),
            "--file".into(),
            file.0.to_str().unwrap().into(),
            "--json".into(),
        ]);
        let request = cli(args);
        assert_eq!(
            request["request"]["request"]["spec"]["quotaPolicy"],
            policy()
        );
        assert_eq!(
            request["request"]["request"]["action"],
            if action == "edit" { "update" } else { "create" }
        );
    }
}
