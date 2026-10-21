use super::*;

#[test]
fn quota_tool_and_cli_share_request_validation_without_accepting_scope_overrides() {
    for program in [None, Some("codex"), Some("claude"), Some("gemini")] {
        for refresh in [false, true] {
            let mut arguments = json!({"refresh":refresh});
            if let Some(program) = program {
                arguments["program"] = program.into();
            }
            let translated = command("nesvo_get_provider_quota", arguments);
            let cli = cli::provider_quota_query(program, refresh);
            match (translated, cli) {
                (Ok((actual, kind)), Ok(expected)) => {
                    assert_eq!(kind, "providerQuota");
                    assert_eq!(actual, expected);
                }
                (Err(_), Err(_)) => {}
                _ => panic!("CLI and MCP quota validation diverged"),
            }
        }
    }
    assert_eq!(
        command("nesvo_get_provider_quota", json!({})).unwrap().0,
        cli::provider_quota_query(None, false).unwrap()
    );
    for bad in [
        json!({"program":null}),
        json!({"program":"shell"}),
        json!({"refresh":"true"}),
        json!({"refresh":null}),
        json!({"program":"codex","owner":true}),
        json!({"program":"codex","accountId":"injected"}),
        json!({"program":"codex","source":"cache"}),
    ] {
        assert!(command("nesvo_get_provider_quota", bad).is_err());
    }
}

#[test]
fn quota_tool_advertises_strict_explicit_refresh_and_no_session_authority() {
    let tool = catalog()
        .into_iter()
        .find(|tool| tool.name == "nesvo_get_provider_quota")
        .unwrap();
    let value = serde_json::to_value(tool).unwrap();
    let schema = &value["inputSchema"];
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["properties"].as_object().unwrap().len(), 3);
    assert_eq!(
        schema["properties"]["program"]["enum"],
        json!(["codex", "claude", "gemini"])
    );
    assert_eq!(schema["properties"]["refresh"]["default"], false);
    assert_eq!(schema["allOf"][0]["then"]["required"], json!(["program"]));
    assert_eq!(value["annotations"]["readOnlyHint"], true);
    assert_eq!(value["annotations"]["destructiveHint"], false);
    assert_eq!(value["annotations"]["openWorldHint"], true);
    assert_eq!(catalog().len(), 107);
    assert_eq!(
        published_tools()
            .iter()
            .filter(|tool| tool.as_str() == "nesvo_get_provider_quota")
            .count(),
        1
    );
    let schema: Value =
        serde_json::from_str(include_str!("../../../docs/harness-cli.schema.json")).unwrap();
    assert_eq!(
        schema["definitions"]["providerQuotaObservation"]["additionalProperties"],
        false
    );
    assert_eq!(
        schema["definitions"]["providerQuotaObservation"]["properties"]["windows"]["maxItems"],
        2
    );
    let properties = &schema["definitions"]["providerQuotaObservation"]["properties"];
    for forbidden in [
        "accountId",
        "codexHome",
        "rawResponse",
        "signature",
        "credentials",
    ] {
        assert!(properties.get(forbidden).is_none());
    }
    assert_eq!(properties["scope"]["const"], "readerSnapshotOnly");
    assert_eq!(
        properties["ordinaryUsageAllowed"]["type"],
        json!(["boolean", "null"])
    );
}
#[test]
fn configured_directory_queries_use_shared_validation_and_strict_null_semantics() {
    let (request, kind) = super::command(
        "nesvo_get_provider_quota",
        serde_json::json!({"program":"codex","directory":"C:\\work","refresh":true}),
    )
    .unwrap();
    assert_eq!(kind, "providerQuota");
    assert_eq!(request["directory"], "C:\\work");
    for arguments in [
        serde_json::json!({"program":"claude","directory":"C:\\work"}),
        serde_json::json!({"directory":"C:\\work"}),
        serde_json::json!({"program":"codex","directory":null}),
    ] {
        assert!(super::command("nesvo_get_provider_quota", arguments).is_err());
    }
}
