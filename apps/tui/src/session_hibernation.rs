use crate::{
    cli::{failure, print_data, request},
    network::Connection,
};
use anyhow::Result;
use serde::Deserialize;
use serde_json::{Value, json};

pub const KIND: &str = "sessionHibernation";
pub const TOOLS: [&str; 2] = ["nesvo_hibernate_session", "nesvo_resume_session"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Hibernate,
    Resume,
}

impl Action {
    fn command(self) -> &'static str {
        match self {
            Self::Hibernate => "hibernateSession",
            Self::Resume => "resumeSession",
        }
    }
}

fn valid(id: &str, key: &str) -> Result<()> {
    if id.len() != 32
        || !id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(failure(
            "invalid_argument",
            "Session ID must be a 32-character host session ID",
        ));
    }
    if key.is_empty() || key.len() > 128 || key.chars().any(char::is_control) {
        return Err(failure(
            "invalid_argument",
            "Idempotency key must be 1-128 bytes without control characters",
        ));
    }
    Ok(())
}

pub fn query(action: Action, id: &str, key: &str) -> Result<(Value, &'static str)> {
    valid(id, key)?;
    Ok((
        json!({"type":action.command(),"sessionId":id,"key":key}),
        KIND,
    ))
}

pub fn check_capability(capabilities: &Value) -> Result<()> {
    if capabilities["hibernation"] != true {
        return Err(failure(
            "unsupported",
            "Host does not support session hibernation; update nesvo-host",
        ));
    }
    Ok(())
}

pub async fn capability(connection: &mut Connection) -> Result<()> {
    let capabilities = request(
        connection,
        json!({"type":"getCapabilities"}),
        "capabilities",
    )
    .await?;
    check_capability(&capabilities)
}

pub async fn run(
    action: Action,
    id: &str,
    key: &str,
    machine: bool,
    connection: &mut Connection,
) -> Result<()> {
    let (query, kind) = query(action, id, key)?;
    capability(connection).await?;
    print_data(machine, request(connection, query, kind).await?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Arguments {
    session_id: String,
    key: String,
}

pub fn command(name: &str, arguments: &Value) -> Option<Result<(Value, &'static str)>> {
    let action = match name {
        "nesvo_hibernate_session" => Action::Hibernate,
        "nesvo_resume_session" => Action::Resume,
        _ => return None,
    };
    Some(
        serde_json::from_value::<Arguments>(arguments.clone())
            .map_err(|_| {
                failure(
                    "invalid_argument",
                    "Hibernation arguments must match the strict tool schema",
                )
            })
            .and_then(|Arguments { session_id, key }| query(action, &session_id, &key)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct Cli {
        #[command(subcommand)]
        command: crate::cli::Command,
    }

    const ID: &str = "0123456789abcdef0123456789abcdef";

    fn session(arguments: &[&str]) -> crate::cli::SessionCommand {
        let mut argv = vec!["nesvo", "session"];
        argv.extend_from_slice(arguments);
        match Cli::try_parse_from(argv).unwrap().command {
            crate::cli::Command::Session { command } => command,
            _ => panic!("session subcommand expected"),
        }
    }

    #[test]
    fn hibernation_cli_builds_keyed_owner_requests_and_refuses_malformed_input() {
        match session(&["hibernate", ID, "--key", "k1", "--json"]) {
            crate::cli::SessionCommand::Hibernate { id, key, json } => {
                assert!(json);
                assert_eq!(
                    query(Action::Hibernate, &id, &key).unwrap(),
                    (
                        json!({"type":"hibernateSession","sessionId":ID,"key":"k1"}),
                        KIND
                    )
                );
            }
            _ => panic!("hibernate expected"),
        }
        match session(&["resume", ID, "--key", "k2"]) {
            crate::cli::SessionCommand::Resume { id, key, json } => {
                assert!(!json);
                assert_eq!(
                    query(Action::Resume, &id, &key).unwrap().0,
                    json!({"type":"resumeSession","sessionId":ID,"key":"k2"})
                );
            }
            _ => panic!("resume expected"),
        }
        for invalid in [
            vec!["nesvo", "session", "hibernate", ID],
            vec!["nesvo", "session", "resume", "--key", "k"],
            vec!["nesvo", "session", "resume", ID, "--key", "k", "--fresh"],
        ] {
            assert!(Cli::try_parse_from(invalid).is_err());
        }
        assert!(query(Action::Hibernate, "SESSION", "k").is_err());
        assert!(query(Action::Resume, ID, "").is_err());
        assert!(query(Action::Resume, ID, "bad\nkey").is_err());
        assert!(check_capability(&json!({"hibernation":true})).is_ok());
        assert!(check_capability(&json!({})).is_err());
    }

    #[test]
    fn hibernation_mcp_tools_are_strict_owner_only_and_published() {
        let tools = crate::mcp_tools::catalog_named(&TOOLS);
        assert_eq!(tools.len(), 2);
        let published: Vec<String> =
            serde_json::from_str(include_str!("../../../docs/harness-mcp-tools.json")).unwrap();
        for tool in &tools {
            assert!(published.iter().any(|name| name == tool.name.as_ref()));
            let value = serde_json::to_value(tool).unwrap();
            assert_eq!(value["inputSchema"]["additionalProperties"], false);
            assert_eq!(
                value["inputSchema"]["required"],
                json!(["sessionId", "key"])
            );
            assert!(
                value["description"]
                    .as_str()
                    .unwrap()
                    .starts_with("Owner-only")
            );
        }
        assert_eq!(
            command(
                "nesvo_hibernate_session",
                &json!({"sessionId":ID,"key":"k"})
            )
            .unwrap()
            .unwrap(),
            (
                json!({"type":"hibernateSession","sessionId":ID,"key":"k"}),
                KIND
            )
        );
        assert_eq!(
            command("nesvo_resume_session", &json!({"sessionId":ID,"key":"k"}))
                .unwrap()
                .unwrap()
                .0["type"],
            "resumeSession"
        );
        for arguments in [
            json!({"sessionId":ID}),
            json!({"sessionId":"bad","key":"k"}),
            json!({"sessionId":ID,"key":"k","fresh":true}),
        ] {
            assert!(
                command("nesvo_resume_session", &arguments)
                    .unwrap()
                    .is_err()
            );
        }
        assert!(command("nesvo_restore_session", &json!({})).is_none());
    }

    #[test]
    fn hibernation_reply_and_session_state_match_the_published_cli_schema() {
        let schema: Value =
            serde_json::from_str(include_str!("../../../docs/harness-cli.schema.json")).unwrap();
        let variant = schema["oneOf"][1]["properties"]["data"]["oneOf"]
            .as_array()
            .unwrap()
            .iter()
            .find(|variant| variant["properties"]["type"]["const"] == KIND)
            .expect("sessionHibernation reply variant");
        assert_eq!(
            variant["properties"]["state"]["enum"],
            json!(["hibernated", "resumed"])
        );
        assert_eq!(
            variant["properties"]["hibernation"]["$ref"],
            "#/definitions/sessionHibernation"
        );
        assert_eq!(
            schema["definitions"]["session"]["properties"]["hibernation"]["$ref"],
            "#/definitions/sessionHibernation"
        );
        assert_eq!(
            schema["definitions"]["sessionHibernation"]["properties"]["trigger"]["enum"],
            json!(["owner", "idlePolicy", "shutdown"])
        );
        assert_eq!(
            variant["properties"]["reason"]["enum"],
            json!(["owner", "restored"])
        );
    }
}
