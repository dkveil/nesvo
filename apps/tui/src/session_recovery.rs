use crate::{
    cli::{failure, print_data, request},
    network::Connection,
};
use anyhow::Result;
use clap::Subcommand;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Subcommand)]
pub enum Command {
    #[command(
        about = "List saved launch descriptions of sessions that are not running; never starts one"
    )]
    List {
        #[arg(long, default_value_t = 0, value_parser = clap::value_parser!(u64).range(0..=4096))]
        offset: u64,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Start a new process from one saved description; old prompts are never replayed"
    )]
    Restore {
        id: String,
        #[arg(
            long,
            help = "Resume the exact recorded provider conversation; refused when none is recorded"
        )]
        resume: bool,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Forget one saved description; running processes and files are untouched")]
    Forget {
        id: String,
        #[arg(long)]
        json: bool,
    },
}

impl Command {
    pub fn machine(&self) -> bool {
        match self {
            Self::List { json, .. } | Self::Restore { json, .. } | Self::Forget { json, .. } => {
                *json
            }
        }
    }
}

fn valid_record(id: &str) -> Result<()> {
    if id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(failure(
            "invalid_argument",
            "Recovery ID must be a 32-character saved session ID",
        ))
    }
}

pub fn query(command: &Command) -> Result<(Value, &'static str)> {
    Ok(match command {
        Command::List { offset, .. } => {
            (json!({"type":"listRecovery","offset":offset}), "recovery")
        }
        Command::Restore { id, resume, .. } => {
            valid_record(id)?;
            (
                json!({"type":"restoreSession","id":id,"exact":resume}),
                "created",
            )
        }
        Command::Forget { id, .. } => {
            valid_record(id)?;
            (json!({"type":"forgetRecovery","id":id}), "recovery")
        }
    })
}

pub fn check_capability(capabilities: &Value, query: &Value) -> Result<()> {
    if capabilities["recovery"] != true {
        return Err(failure(
            "unsupported",
            "Host does not support session recovery; update nesvo-host",
        ));
    }
    if query["exact"] == true && capabilities["conversationResume"] != true {
        return Err(failure(
            "unsupported",
            "Host cannot verify an exact conversation resume; update nesvo-host",
        ));
    }
    Ok(())
}

pub async fn capability(connection: &mut Connection, query: &Value) -> Result<()> {
    let capabilities = request(
        connection,
        json!({"type":"getCapabilities"}),
        "capabilities",
    )
    .await?;
    check_capability(&capabilities, query)
}

pub async fn run(command: Command, connection: &mut Connection) -> Result<()> {
    let machine = command.machine();
    let (query, kind) = query(&command)?;
    capability(connection, &query).await?;
    print_data(machine, request(connection, query, kind).await?)
}

pub const TOOLS: [&str; 3] = [
    "nesvo_list_recovery",
    "nesvo_restore_session",
    "nesvo_forget_recovery",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct List {
    #[serde(default)]
    offset: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Restore {
    id: String,
    #[serde(default)]
    resume: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Forget {
    id: String,
}

fn parse<T: serde::de::DeserializeOwned>(arguments: &Value) -> Result<T> {
    serde_json::from_value(arguments.clone()).map_err(|_| {
        failure(
            "invalid_argument",
            "Recovery arguments must match the strict tool schema",
        )
    })
}

pub fn command(name: &str, arguments: &Value) -> Option<Result<(Value, &'static str)>> {
    let index = TOOLS.iter().position(|tool| *tool == name)?;
    Some((|| {
        let command = match index {
            0 => {
                let List { offset } = parse(arguments)?;
                if offset > 4096 {
                    return Err(failure("invalid_argument", "offset must be 0–4096"));
                }
                Command::List { offset, json: true }
            }
            1 => {
                let Restore { id, resume } = parse(arguments)?;
                Command::Restore {
                    id,
                    resume,
                    json: true,
                }
            }
            _ => {
                let Forget { id } = parse(arguments)?;
                Command::Forget { id, json: true }
            }
        };
        query(&command)
    })())
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

    fn recover(arguments: &[&str]) -> Command {
        let mut argv = vec!["nesvo", "session", "recover"];
        argv.extend_from_slice(arguments);
        match Cli::try_parse_from(argv).unwrap().command {
            crate::cli::Command::Session {
                command: crate::cli::SessionCommand::Recover { command },
            } => command,
            _ => panic!("recover subcommand expected"),
        }
    }

    #[test]
    fn recover_cli_builds_list_restore_and_forget_requests() {
        let list = recover(&["list", "--json"]);
        assert!(list.machine());
        assert_eq!(
            query(&list).unwrap(),
            (json!({"type":"listRecovery","offset":0}), "recovery")
        );
        assert_eq!(
            query(&recover(&["restore", ID])).unwrap(),
            (
                json!({"type":"restoreSession","id":ID,"exact":false}),
                "created"
            )
        );
        assert_eq!(
            query(&recover(&["restore", ID, "--resume", "--json"])).unwrap(),
            (
                json!({"type":"restoreSession","id":ID,"exact":true}),
                "created"
            )
        );
        assert_eq!(
            query(&recover(&["forget", ID])).unwrap(),
            (json!({"type":"forgetRecovery","id":ID}), "recovery")
        );
        assert!(query(&recover(&["restore", "not-a-record"])).is_err());
        for invalid in [
            vec!["nesvo", "session", "recover", "restore"],
            vec!["nesvo", "session", "recover", "list", "--offset", "4097"],
            vec!["nesvo", "session", "recover", "restore", ID, "--picker"],
        ] {
            assert!(Cli::try_parse_from(invalid).is_err());
        }
    }

    #[test]
    fn recover_cli_refuses_exact_resume_on_a_host_without_verification() {
        let exact = json!({"type":"restoreSession","id":ID,"exact":true});
        let fresh = json!({"type":"restoreSession","id":ID,"exact":false});
        assert!(check_capability(&json!({"recovery":true}), &fresh).is_ok());
        assert!(check_capability(&json!({"recovery":true}), &exact).is_err());
        assert!(
            check_capability(&json!({"recovery":true,"conversationResume":true}), &exact).is_ok()
        );
        assert!(check_capability(&json!({}), &fresh).is_err());
    }

    #[test]
    fn recovery_mcp_tools_are_strict_owner_only_and_published() {
        let tools = crate::mcp_tools::catalog_named(&TOOLS);
        assert_eq!(tools.len(), 3);
        let published: Vec<String> =
            serde_json::from_str(include_str!("../../../docs/harness-mcp-tools.json")).unwrap();
        for tool in &tools {
            assert!(published.iter().any(|name| name == tool.name.as_ref()));
            let value = serde_json::to_value(tool).unwrap();
            assert_eq!(value["inputSchema"]["additionalProperties"], false);
            assert!(
                value["description"]
                    .as_str()
                    .unwrap()
                    .starts_with("Owner-only")
            );
        }
        let restore = serde_json::to_value(&tools[1]).unwrap();
        assert_eq!(restore["annotations"]["idempotentHint"], false);
        assert_eq!(
            restore["inputSchema"]["properties"]["resume"]["default"],
            false
        );
        assert_eq!(
            command("nesvo_restore_session", &json!({"id":ID,"resume":true}))
                .unwrap()
                .unwrap(),
            (
                json!({"type":"restoreSession","id":ID,"exact":true}),
                "created"
            )
        );
        assert_eq!(
            command("nesvo_list_recovery", &json!({})).unwrap().unwrap(),
            (json!({"type":"listRecovery","offset":0}), "recovery")
        );
        assert_eq!(
            command("nesvo_forget_recovery", &json!({"id":ID}))
                .unwrap()
                .unwrap(),
            (json!({"type":"forgetRecovery","id":ID}), "recovery")
        );
        for (name, arguments) in [
            ("nesvo_restore_session", json!({"id":ID,"prompt":"again"})),
            ("nesvo_restore_session", json!({"id":ID,"exact":true})),
            ("nesvo_restore_session", json!({"id":"bad"})),
            ("nesvo_forget_recovery", json!({})),
            ("nesvo_list_recovery", json!({"offset":4097})),
        ] {
            assert!(command(name, &arguments).unwrap().is_err(), "{name}");
        }
        assert!(command("nesvo_list_sessions", &json!({})).is_none());
    }

    #[test]
    fn recovery_mcp_output_matches_the_published_cli_schema() {
        let schema: Value =
            serde_json::from_str(include_str!("../../../docs/harness-cli.schema.json")).unwrap();
        let definitions = &schema["definitions"];
        assert_eq!(
            definitions["resumeVerification"]["properties"]["state"]["enum"],
            json!(["pending", "verified", "resumeFailed"])
        );
        assert_eq!(
            definitions["recoveryRecord"]["properties"]["spec"]["properties"]["resume"]["$ref"],
            "#/definitions/resumeTarget"
        );
        assert_eq!(
            definitions["resumeTarget"]["properties"]["provider"]["enum"],
            json!(["claude", "codex", "gemini"])
        );
        assert_eq!(
            definitions["session"]["properties"]["resume"]["$ref"],
            "#/definitions/resumeVerification"
        );
    }
}
