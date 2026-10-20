//! Owner-selected native permission additions, not host capabilities or a sandbox.
use crate::api_error::Error;
use anyhow::Result;
use std::collections::HashSet;

pub fn validate(tools: &[String]) -> Result<()> {
    if tools.is_empty() {
        return Ok(());
    }
    if tools.len() > 32 {
        return Err(Error::new(
            "invalid_argument",
            "Select at most 32 exact Nesvo tool names",
        )
        .into());
    }
    // Shared public data contract, checked against the native MCP catalog by TUI
    // tests. Neither application depends on the other's executable/library.
    let known: Vec<String> =
        serde_json::from_str(include_str!("../../../docs/harness-mcp-tools.json"))?;
    let mut seen = HashSet::new();
    for tool in tools {
        if !known.contains(tool) || !seen.insert(tool) {
            return Err(Error::new("invalid_argument", "Use unique exact names from the Nesvo MCP catalog; wildcards and native permission rules are not accepted").into());
        }
    }
    Ok(())
}

pub fn rules(tools: &[String]) -> Vec<String> {
    tools
        .iter()
        .map(|name| format!("mcp__nesvo__{name}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_bounded_unique_exact_published_tools_can_add_native_permission() {
        validate(&[]).unwrap();
        validate(&["nesvo_create_session".into(), "nesvo_get_session".into()]).unwrap();
        assert_eq!(
            rules(&["nesvo_create_session".into()]),
            vec!["mcp__nesvo__nesvo_create_session"]
        );
        for bad in [
            vec!["*".into()],
            vec!["mcp__nesvo__*".into()],
            vec!["Bash".into()],
            vec!["nesvo_future_tool".into()],
            vec!["nesvo_create_session\nBash".into()],
            vec!["nesvo_create_session".into(); 2],
            vec!["nesvo_get_session".into(); 33],
        ] {
            assert!(validate(&bad).is_err());
        }
    }
}
