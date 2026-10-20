//! MCP description and translation of the shared owner trigger DTOs.
use anyhow::Result;
use rmcp::model::{Tool, ToolAnnotations};
use serde_json::{Value, json};
use std::sync::Arc;

pub const ACTIONS: [(&str, &str, bool); 10] = [
    ("nesvo_create_job_trigger", "create", false),
    ("nesvo_update_job_trigger", "update", false),
    ("nesvo_get_job_trigger", "get", true),
    ("nesvo_list_job_triggers", "list", true),
    ("nesvo_set_job_trigger_enabled", "setEnabled", false),
    ("nesvo_rotate_job_trigger", "rotate", false),
    ("nesvo_revoke_job_trigger", "revoke", false),
    ("nesvo_get_job_trigger_deliveries", "deliveries", true),
    ("nesvo_get_job_trigger_delivery", "delivery", true),
    ("nesvo_get_job_trigger_mutation", "mutation", true),
];
fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","additionalProperties":false,"properties":properties,"required":required})
}
fn spec_schema() -> Value {
    let name = json!({"type":"string","minLength":1,"maxLength":64,"pattern":"^[A-Za-z0-9_.:-]+$"});
    let mut github = object(
        json!({"kind":{"const":"github"},"repositoryId":{"type":"integer","minimum":1},"repository":{"type":"string","pattern":"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$","maxLength":201},"event":{"enum":["push","pull_request","workflow_run"]},"actions":{"type":"array","maxItems":16,"uniqueItems":true,"items":name},"branch":{"type":["string","null"],"minLength":1,"maxLength":255,"pattern":"^\\S+$"}}),
        &[
            "kind",
            "repositoryId",
            "repository",
            "event",
            "actions",
            "branch",
        ],
    );
    github["oneOf"] = json!([
        {"properties":{"event":{"const":"push"},"actions":{"maxItems":0}}},
        {"properties":{"event":{"const":"pull_request"},"actions":{"minItems":1,"items":{"enum":crate::job_triggers::PULL_REQUEST_ACTIONS}}}},
        {"properties":{"event":{"const":"workflow_run"},"actions":{"const":["completed"]}}}
    ]);
    object(
        json!({"title":{"type":"string","minLength":1,"maxLength":80},"jobId":{"type":"string","pattern":"^[0-9a-f]{32}$"},"jobRevision":{"type":"integer","minimum":1},"adapter":{"oneOf":[object(json!({"kind":{"const":"webhook"},"event":name}),&["kind","event"]),github]}}),
        &["title", "jobId", "jobRevision", "adapter"],
    )
}
pub fn catalog() -> Vec<Tool> {
    let id = json!({"type":"string","pattern":"^[0-9a-f]{32}$"});
    let key = json!({"type":"string","minLength":1,"maxLength":128});
    let secret = json!({"type":"string","pattern":"^[0-9a-f]{64}$","description":"Separate random secret TEXT, never owner pairing. Request-only, not returned. GitHub HMAC key uses the 64 ASCII bytes, not hex decoding. Never reuse across trigger routes or rotations."});
    ACTIONS.into_iter().map(|(name,action,read_only)| {
        let schema=match action {
            "create"=>object(json!({"key":key,"spec":spec_schema(),"secret":secret}),&["key","spec","secret"]),
            "update"=>object(json!({"key":key,"id":id,"expectedRevision":{"type":"integer","minimum":1},"spec":spec_schema()}),&["key","id","expectedRevision","spec"]),
            "setEnabled"=>object(json!({"key":key,"id":id,"expectedRevision":{"type":"integer","minimum":1},"enabled":{"type":"boolean"}}),&["key","id","expectedRevision","enabled"]),
            "rotate"=>object(json!({"key":key,"id":id,"expectedRevision":{"type":"integer","minimum":1},"secret":secret}),&["key","id","expectedRevision","secret"]),
            "revoke"=>object(json!({"key":key,"id":id,"expectedRevision":{"type":"integer","minimum":1}}),&["key","id","expectedRevision"]),
            "get"=>object(json!({"id":id}),&["id"]),
            "list"=>object(json!({"offset":{"type":"integer","minimum":0,"maximum":4096,"default":0}}),&[]),
            "deliveries"=>object(json!({"id":id,"offset":{"type":"integer","minimum":0,"maximum":4096,"default":0}}),&["id"]),
            "delivery"=>object(json!({"id":id,"deliveryId":{"type":"string","minLength":1,"maxLength":128}}),&["id","deliveryId"]),
            _=>object(json!({"key":key}),&["key"]),
        };
        let description=match action {
            "create"=>"Owner-only registration of a disabled external job trigger with a separate secret and exact current job intent. No listener activation, webhook account registration, model call or provider grant. Enable separately after inspection.",
            "update"=>"Owner-only exact-revision trigger filter/job-intent reauthorization. Same job and provider only; existing delivery receipts remain immutable and payload never chooses tools or instructions.",
            "setEnabled"=>"Owner-only explicit enable/disable for future external delivery. Does not cancel admitted occurrences or bypass job enablement. Revocation is permanent.",
            "rotate"=>"Owner-only exact-revision credential rotation with a never-used random secret. Retired credentials no longer authenticate, including delivery replay. Does not retry events or reauthorize changed job intent.",
            "revoke"=>"Owner-only permanent revocation of this trigger credential. Preserves accepted delivery history; does not stop already admitted workers or cancel occurrences.",
            _=>"Owner-only retained trigger metadata/delivery inspection. No secret, raw body, signature, model input or dispatch. Follow nextOffset; mutation reads recover original immutable acceptance.",
        };
        Tool::new(name,description,serde_json::from_value::<serde_json::Map<String,Value>>(schema).expect("constant trigger input schema"))
            .with_annotations(ToolAnnotations::new().read_only(read_only).destructive(action=="revoke").idempotent(true).open_world(!read_only))
            .with_raw_output_schema(Arc::new(serde_json::from_value(json!({"type":"object","required":["schemaVersion","ok"],"properties":{"schemaVersion":{"const":1},"ok":{"type":"boolean"},"data":{"type":"object"},"error":{"type":"object"}}})).expect("constant trigger response schema")))
    }).collect()
}
pub fn command(name: &str, arguments: &Value) -> Option<Result<Value>> {
    let (_, action, _) = ACTIONS
        .iter()
        .find(|(candidate, _, _)| *candidate == name)?;
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
        assert_eq!(catalog().len(), 10);
    }
}
