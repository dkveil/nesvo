use anyhow::Result;
use serde_json::{Value, json};

pub const ACTIONS: [(&str, &str); 10] = [
    ("nesvo_create_job_trigger", "create"),
    ("nesvo_update_job_trigger", "update"),
    ("nesvo_get_job_trigger", "get"),
    ("nesvo_list_job_triggers", "list"),
    ("nesvo_set_job_trigger_enabled", "setEnabled"),
    ("nesvo_rotate_job_trigger", "rotate"),
    ("nesvo_revoke_job_trigger", "revoke"),
    ("nesvo_get_job_trigger_deliveries", "deliveries"),
    ("nesvo_get_job_trigger_delivery", "delivery"),
    ("nesvo_get_job_trigger_mutation", "mutation"),
];
pub fn command(name: &str, arguments: &Value) -> Option<Result<Value>> {
    let (_, action) = ACTIONS.iter().find(|(candidate, _)| *candidate == name)?;
    Some((|| {
        let mut fields = arguments
            .as_object()
            .ok_or_else(|| {
                crate::cli::failure("invalid_argument", "Trigger arguments must be an object")
            })?
            .clone();
        if fields.contains_key("action") {
            return Err(crate::cli::failure(
                "invalid_argument",
                "Trigger action is selected by its tool name",
            ));
        }
        fields.insert("action".into(), (*action).into());
        let request: crate::job_triggers::Request = serde_json::from_value(Value::Object(fields))
            .map_err(|_| {
            crate::cli::failure(
                "invalid_argument",
                "Trigger fields must match the strict tool schema",
            )
        })?;
        request.validate()?;
        crate::workflow::tool(
            "jobs",
            json!({"request":{"action":"triggers","request":request}}),
        )
    })())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tool_translation_is_strict_and_never_allows_an_action_or_secret_override() {
        let args = json!({"key":"trigger","spec":{"title":"Checks","jobId":"a".repeat(32),"jobRevision":1,"adapter":{"kind":"webhook","event":"checks"}},"secret":"b".repeat(64)});
        let request = command("nesvo_create_job_trigger", &args).unwrap().unwrap();
        assert_eq!(request["request"]["request"]["action"], "triggers");
        assert_eq!(request["request"]["request"]["request"]["action"], "create");
        for (field, value) in [
            ("secret", json!("A".repeat(64))),
            ("action", json!("revoke")),
            ("expectedRevision", json!(1)),
        ] {
            let mut bad = args.clone();
            bad[field] = value;
            assert!(command("nesvo_create_job_trigger", &bad).unwrap().is_err());
        }
        assert!(command("not_a_trigger_tool", &args).is_none());
    }
}
