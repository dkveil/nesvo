use crate::{
    cli::{failure, print_data, request},
    network::Connection,
};
use anyhow::Result;
use clap::Subcommand;
use serde::Deserialize;
use serde_json::{Value, json};

const ROOT_BYTES: usize = 4096;
const LAYOUT_CHARS: usize = 40;

#[derive(Subcommand)]
pub enum Command {
    #[command(
        about = "List repositories the host has seen, pinned first, with open sessions and last activity"
    )]
    List {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Pin a project so it stays first and is kept when the registry is full")]
    Pin {
        root: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Unpin a project; it is then ordered by last activity")]
    Unpin {
        root: String,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Show a project's worktree setup state, default layout and usual launch folder"
    )]
    Defaults {
        root: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Set or clear the host-wide default layout name of a project")]
    Layout {
        root: String,
        #[arg(required_unless_present = "clear", conflicts_with = "clear")]
        name: Option<String>,
        #[arg(long)]
        clear: bool,
        #[arg(long)]
        json: bool,
    },
}

impl Command {
    pub fn machine(&self) -> bool {
        match self {
            Self::List { json }
            | Self::Pin { json, .. }
            | Self::Unpin { json, .. }
            | Self::Defaults { json, .. }
            | Self::Layout { json, .. } => *json,
        }
    }
}

pub fn valid_root(root: &str) -> Result<()> {
    if root.is_empty()
        || root.len() > ROOT_BYTES
        || root.chars().any(char::is_control)
        || !std::path::Path::new(root).is_absolute()
    {
        return Err(failure(
            "invalid_argument",
            "Use the absolute host path of a repository root",
        ));
    }
    Ok(())
}

fn valid_layout(name: &str) -> Result<()> {
    if name.is_empty()
        || name.trim() != name
        || name.chars().count() > LAYOUT_CHARS
        || name.chars().any(char::is_control)
    {
        return Err(failure(
            "invalid_argument",
            "Use a layout name of 1-40 characters without control characters",
        ));
    }
    Ok(())
}

pub fn query(command: &Command) -> Result<(Value, &'static str)> {
    Ok(match command {
        Command::List { .. } => (json!({"type":"listProjects"}), "projects"),
        Command::Pin { root, .. } => {
            valid_root(root)?;
            (json!({"type":"pinProject","root":root}), "projectPinned")
        }
        Command::Unpin { root, .. } => {
            valid_root(root)?;
            (json!({"type":"unpinProject","root":root}), "projectPinned")
        }
        Command::Defaults { root, .. } => {
            valid_root(root)?;
            (
                json!({"type":"projectDefaults","root":root}),
                "projectDefaults",
            )
        }
        Command::Layout {
            root, name, clear, ..
        } => {
            valid_root(root)?;
            let layout = if *clear { None } else { name.as_deref() };
            match layout {
                Some(name) => valid_layout(name)?,
                None if !clear => {
                    return Err(failure("invalid_argument", "Name a layout or pass --clear"));
                }
                None => {}
            }
            (
                json!({"type":"setProjectLayout","root":root,"layout":layout}),
                "projectLayout",
            )
        }
    })
}

pub fn check_capability(capabilities: &Value) -> Result<()> {
    if capabilities["projects"] != true {
        return Err(failure(
            "unsupported",
            "Host does not keep a project registry; update nesvo-host",
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

pub async fn run(command: Command, connection: &mut Connection) -> Result<()> {
    let machine = command.machine();
    let (query, kind) = query(&command)?;
    capability(connection).await?;
    print_data(machine, request(connection, query, kind).await?)
}

pub const TOOLS: [&str; 2] = ["nesvo_list_projects", "nesvo_project_defaults"];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Root {
    root: String,
}

fn parse<T: serde::de::DeserializeOwned>(arguments: &Value) -> Result<T> {
    serde_json::from_value(arguments.clone()).map_err(|_| {
        failure(
            "invalid_argument",
            "Project arguments must match the strict tool schema",
        )
    })
}

pub fn command(name: &str, arguments: &Value) -> Option<Result<(Value, &'static str)>> {
    let index = TOOLS.iter().position(|tool| *tool == name)?;
    Some((|| {
        let command = if index == 0 {
            let Empty {} = parse(arguments)?;
            Command::List { json: true }
        } else {
            let Root { root } = parse(arguments)?;
            Command::Defaults { root, json: true }
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

    fn root() -> String {
        if cfg!(windows) {
            "C:\\dev\\nesvo".into()
        } else {
            "/dev/nesvo".into()
        }
    }

    fn project(arguments: &[&str]) -> Command {
        let mut argv = vec!["nesvo", "project"];
        argv.extend_from_slice(arguments);
        match Cli::try_parse_from(argv).unwrap().command {
            crate::cli::Command::Project { command } => command,
            _ => panic!("project subcommand expected"),
        }
    }

    #[test]
    fn projects_cli_builds_list_pin_unpin_defaults_and_layout_requests() {
        let root = root();
        let list = project(&["list", "--json"]);
        assert!(list.machine());
        assert_eq!(
            query(&list).unwrap(),
            (json!({"type":"listProjects"}), "projects")
        );
        assert_eq!(
            query(&project(&["pin", &root])).unwrap(),
            (json!({"type":"pinProject","root":root}), "projectPinned")
        );
        assert_eq!(
            query(&project(&["unpin", &root])).unwrap(),
            (json!({"type":"unpinProject","root":root}), "projectPinned")
        );
        assert_eq!(
            query(&project(&["defaults", &root, "--json"])).unwrap(),
            (
                json!({"type":"projectDefaults","root":root}),
                "projectDefaults"
            )
        );
        assert_eq!(
            query(&project(&["layout", &root, "Quad"])).unwrap(),
            (
                json!({"type":"setProjectLayout","root":root,"layout":"Quad"}),
                "projectLayout"
            )
        );
        assert_eq!(
            query(&project(&["layout", &root, "--clear"])).unwrap().0["layout"],
            Value::Null
        );
        assert!(query(&project(&["pin", "relative/repo"])).is_err());
        assert!(query(&project(&["layout", &root, " Quad"])).is_err());
        for invalid in [
            vec!["nesvo", "project", "pin"],
            vec!["nesvo", "project", "layout", "/r"],
            vec!["nesvo", "project", "layout", "/r", "Quad", "--clear"],
            vec!["nesvo", "project", "list", "--root", "/r"],
        ] {
            assert!(Cli::try_parse_from(invalid).is_err());
        }
        assert!(check_capability(&json!({"projects":true})).is_ok());
        assert!(check_capability(&json!({})).is_err());
    }

    #[test]
    fn projects_mcp_tools_are_strict_owner_only_reads_matching_the_cli_wire() {
        let tools = crate::mcp_tools::catalog_named(&TOOLS);
        assert_eq!(tools.len(), 2);
        let published: Vec<String> =
            serde_json::from_str(include_str!("../../../docs/harness-mcp-tools.json")).unwrap();
        for tool in &tools {
            assert!(published.iter().any(|name| name == tool.name.as_ref()));
            let value = serde_json::to_value(tool).unwrap();
            assert_eq!(value["inputSchema"]["additionalProperties"], false);
            assert_eq!(value["annotations"]["readOnlyHint"], true);
            assert_eq!(value["annotations"]["destructiveHint"], false);
            assert!(
                value["description"]
                    .as_str()
                    .unwrap()
                    .starts_with("Owner-only")
            );
        }
        let root = root();
        assert_eq!(
            command("nesvo_list_projects", &json!({})).unwrap().unwrap(),
            query(&Command::List { json: true }).unwrap()
        );
        assert_eq!(
            command("nesvo_project_defaults", &json!({"root":root}))
                .unwrap()
                .unwrap(),
            query(&Command::Defaults {
                root: root.clone(),
                json: true
            })
            .unwrap()
        );
        for (name, arguments) in [
            ("nesvo_list_projects", json!({"root":root})),
            ("nesvo_project_defaults", json!({})),
            ("nesvo_project_defaults", json!({"root":"relative"})),
            ("nesvo_project_defaults", json!({"root":root,"pin":true})),
        ] {
            assert!(
                command(name, &arguments).unwrap().is_err(),
                "{name} {arguments}"
            );
        }
        assert!(command("nesvo_pin_project", &json!({})).is_none());
    }
}
