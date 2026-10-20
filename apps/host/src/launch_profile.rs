//! Launch-local model selection. Requested flags are not resolved provider state.
use crate::{
    api_error::Error,
    launchers::{Program, Version},
};
use anyhow::Result;
use serde_json::{Value, json};

#[derive(Clone, Default)]
pub struct Selection {
    pub model: Option<String>,
    pub effort: Option<String>,
}
impl Selection {
    pub fn configured(&self) -> bool {
        self.model.is_some() || self.effort.is_some()
    }
    pub fn diagnostic(&self) -> Value {
        json!({"requested":{"model":self.model,"effort":self.effort},"resolved":null,
            "source":if self.configured(){"launch"}else{"providerDefaults"},
            "scope":"process","inheritedByChildren":false})
    }
}
fn supported(program: Program, version: &str) -> bool {
    match program {
        Program::Claude => crate::caller::supports_claude_harness(version),
        Program::Codex => crate::codex_context::supported(version),
        _ => false,
    }
}
pub fn capabilities(versions: &[Version]) -> Value {
    json!(versions.iter().map(|v| {
        let ready=v.status=="ready"&&v.version.as_deref().is_some_and(|version|supported(v.program,version));
        json!({"program":v.program,"version":v.version,"probeStatus":v.status,"supported":ready,
            "modelFlag":if ready {Some("--model")}else{None},
            "effortValues":if ready&&v.program==Program::Claude {Some(vec!["low","medium","high","xhigh","max"])}else{None},
            "effortSource":if !ready {None}else if v.program==Program::Codex {Some("modelAdvertised")}else{Some("cli")},
            "explicitModelRequiredForEffort":true})
    }).collect::<Vec<_>>())
}
pub fn validate(program: Program, versions: &[Version], selection: &Selection) -> Result<()> {
    if !selection.configured() {
        return Ok(());
    }
    if selection.model.as_deref().is_none_or(|m| {
        m.is_empty()
            || m.len() > 256
            || m.trim() != m
            || m.starts_with('-')
            || m.chars().any(char::is_control)
    }) {
        return Err(Error::new("invalid_argument","Explicit model selection is required, 1–256 UTF-8 bytes, without surrounding whitespace, control characters or a leading dash").into());
    }
    if let Some(effort) = &selection.effort {
        let valid = match program {
            Program::Claude => {
                matches!(effort.as_str(), "low" | "medium" | "high" | "xhigh" | "max")
            }
            // Codex 0.156 uses a model-advertised nonempty string, not a fixed enum.
            // Accept a bounded literal identifier; the selected model validates support.
            Program::Codex => {
                !effort.is_empty()
                    && effort.len() <= 32
                    && effort.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-')
                    })
            }
            _ => false,
        };
        if !valid {
            return Err(Error::new(
                "invalid_argument",
                "Unsupported effort syntax for this provider; inspect launch profile support",
            )
            .into());
        }
    }
    if !versions.iter().any(|v| {
        v.program == program
            && v.status == "ready"
            && v.version.as_deref().is_some_and(|v| supported(program, v))
    }) {
        return Err(Error::new("unsupported","Model profiles require a probed supported provider: Claude 2.1.303+ in 2.1 or Codex 0.156; inspect doctor providerVersions").into());
    }
    Ok(())
}
pub fn arguments(program: Program, selection: &Selection) -> Result<Vec<String>> {
    let mut args = Vec::new();
    if let Some(model) = &selection.model {
        args.extend(["--model".into(), model.clone()]);
    }
    if let Some(effort) = &selection.effort {
        match program {
            Program::Claude => args.extend(["--effort".into(), effort.clone()]),
            Program::Codex => args.extend([
                "-c".into(),
                format!("model_reasoning_effort={}", serde_json::to_string(effort)?),
            ]),
            _ => {
                return Err(Error::new(
                    "unsupported",
                    "Provider model profile adapter is unavailable",
                )
                .into());
            }
        }
    }
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn versions() -> Vec<Version> {
        vec![
            Version {
                program: Program::Claude,
                status: "ready",
                version: Some("2.1.304".into()),
            },
            Version {
                program: Program::Codex,
                status: "ready",
                version: Some("0.156.0".into()),
            },
        ]
    }
    #[test]
    fn validates_literal_model_and_versioned_provider_effort_without_claiming_resolution() {
        let selected = Selection {
            model: Some("deployment łódź $(literal)".into()),
            effort: Some("low".into()),
        };
        validate(Program::Claude, &versions(), &selected).unwrap();
        assert_eq!(
            arguments(Program::Claude, &selected).unwrap(),
            vec!["--model", "deployment łódź $(literal)", "--effort", "low"]
        );
        assert_eq!(selected.diagnostic()["resolved"], Value::Null);
        assert_eq!(
            arguments(Program::Codex, &selected).unwrap(),
            vec![
                "--model",
                "deployment łódź $(literal)",
                "-c",
                "model_reasoning_effort=\"low\""
            ]
        );
        validate(Program::Shell, &[], &Selection::default()).unwrap();
        for bad in ["", "--permission-mode", "bad\nmodel", " model", "model "] {
            assert!(
                validate(
                    Program::Claude,
                    &versions(),
                    &Selection {
                        model: Some(bad.into()),
                        effort: None
                    }
                )
                .is_err()
            );
        }
        for program in [Program::Shell, Program::Gemini] {
            assert!(validate(program, &versions(), &selected).is_err());
        }
        for effort in ["ultra", "ultracode", "-c", "low\nBash"] {
            assert!(
                validate(
                    Program::Claude,
                    &versions(),
                    &Selection {
                        model: Some("opus".into()),
                        effort: Some(effort.into())
                    }
                )
                .is_err()
            );
        }
        assert!(
            validate(
                Program::Claude,
                &versions(),
                &Selection {
                    model: None,
                    effort: Some("low".into())
                }
            )
            .is_err()
        );
        assert!(
            validate(
                Program::Codex,
                &versions(),
                &Selection {
                    model: Some("gpt-model".into()),
                    effort: Some("low\nsandbox_mode=other".into())
                }
            )
            .is_err()
        );
        assert!(validate(Program::Claude, &[], &selected).is_err());
        assert!(!supported(Program::Codex, "0.157.0"));
        assert!(!supported(Program::Claude, "2.2.0"));
    }
}
