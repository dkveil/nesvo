use super::*;
use clap::Parser;

#[test]
fn quota_wake_cli_parse_and_wire_keep_read_enable_and_disable_distinct() {
    for (flags, enabled, kind) in [
        (vec![], None, "quotaWake"),
        (vec!["--enable"], Some(true), "wakeConfigured"),
        (vec!["--disable"], Some(false), "wakeConfigured"),
    ] {
        let mut args = vec!["nesvo", "session", "wake", "stable-session"];
        args.extend(flags);
        args.push("--json");
        let parsed = crate::Arguments::try_parse_from(args).unwrap();
        let command = parsed.command.unwrap();
        assert!(command.machine());
        let Command::Session {
            command:
                SessionCommand::Wake {
                    id,
                    enable,
                    disable,
                    json,
                },
        } = command
        else {
            panic!("Expected quota wake");
        };
        assert!(json);
        assert_eq!(
            (enable, disable),
            (enabled == Some(true), enabled == Some(false))
        );
        let (query, actual) = quota_wake_query(&id, enabled).unwrap();
        assert_eq!(actual, kind);
        let expected = match enabled {
            Some(value) => json!({"type":"setWake","sessionId":"stable-session","enabled":value}),
            None => json!({"type":"getQuotaWake","sessionId":"stable-session"}),
        };
        assert_eq!(query, expected);
    }
    for args in [
        vec!["nesvo", "session", "wake"],
        vec!["nesvo", "session", "wake", "s", "--enable", "--disable"],
        vec!["nesvo", "session", "wake", "s", "--enable", "true"],
        vec!["nesvo", "session", "wake", "s", "--program", "claude"],
        vec!["nesvo", "session", "wake", "s", "--key", "new-input"],
    ] {
        assert!(crate::Arguments::try_parse_from(args).is_err());
    }
    for id in ["".to_owned(), "bad\nidentity".into(), "s".repeat(129)] {
        for enabled in [None, Some(false), Some(true)] {
            assert!(quota_wake_query(&id, enabled).is_err());
        }
    }
}

#[test]
fn durable_quota_wake_capability_requires_exact_boolean_true_without_fallback() {
    for caps in [
        json!({}),
        json!({"quotaWake":true,"providerQuotaObservations":true,"providerQuotaContexts":true}),
        json!({"durableQuotaWake":false}),
        json!({"durableQuotaWake":null}),
        json!({"durableQuotaWake":"true"}),
        json!({"durableQuotaWake":1}),
        json!({"durableQuotaWake":{}}),
        json!({"durableQuotaWake":[]}),
    ] {
        let error = check_quota_wake_capability(&caps).unwrap_err();
        assert_eq!(error_value(&error)["error"]["code"], "unsupported");
    }
    check_quota_wake_capability(&json!({"durableQuotaWake":true})).unwrap();
}

#[test]
fn quota_wake_output_schema_is_nullable_and_exposes_no_private_proof() {
    let schema: Value =
        serde_json::from_str(include_str!("../../../docs/harness-cli.schema.json")).unwrap();
    let wake = &schema["definitions"]["quotaWake"];
    assert_eq!(wake["additionalProperties"], false);
    assert_eq!(wake["properties"].as_object().unwrap().len(), 10);
    assert_eq!(wake["required"].as_array().unwrap().len(), 10);
    assert_eq!(
        wake["properties"]["phase"]["enum"],
        json!(["armed", "dispatching", "paused"])
    );
    let source = &wake["properties"]["source"];
    assert_eq!(source["additionalProperties"], false);
    assert_eq!(source["properties"].as_object().unwrap().len(), 5);
    for private in [
        "readStartedElapsedMs",
        "resetElapsedMs",
        "humanEpoch",
        "accountId",
        "codexHome",
        "prompt",
    ] {
        assert!(
            !wake.to_string().contains(private),
            "Private quota proof leaked into output schema"
        );
    }
    let alternatives = schema["oneOf"][1]["properties"]["data"]["oneOf"]
        .as_array()
        .unwrap();
    for kind in ["quotaWake", "wakeConfigured"] {
        let output = alternatives
            .iter()
            .find(|value| value["properties"]["type"]["const"] == kind)
            .unwrap();
        assert_eq!(output["additionalProperties"], false);
        assert_eq!(
            output["properties"]["quotaWake"]["anyOf"],
            json!([{"type":"null"},{"$ref":"#/definitions/quotaWake"}])
        );
    }
}
