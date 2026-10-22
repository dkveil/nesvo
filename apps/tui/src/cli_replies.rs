mod attention;
mod context;
mod digest;
mod jobs;
mod pool;
mod projects;
mod quota;
mod review;
mod runs;
mod servers;
mod session;
mod templates;
mod triggers;
mod wakes;
mod worktrees;

pub use attention::*;
pub use context::*;
pub use digest::*;
pub use jobs::*;
pub use pool::*;
pub use projects::*;
pub use quota::*;
pub use review::*;
pub use runs::*;
pub use servers::*;
pub use session::*;
pub use templates::*;
pub use triggers::*;
pub use wakes::*;
pub use worktrees::*;

use schemars::{JsonSchema, Schema};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

const SCHEMA_VERSION: u64 = 1;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
#[schemars(transform = one_of)]
pub enum Envelope {
    Failure(Box<FailureEnvelope>),
    Success(Box<SuccessEnvelope>),
    Diagnostics(Box<DiagnosticsReport>),
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct FailureEnvelope {
    #[schemars(extend("const" = 1))]
    pub schema_version: u64,
    #[schemars(extend("const" = false))]
    pub ok: bool,
    pub error: FailureError,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct FailureError {
    #[schemars(pattern("^[a-z][a-z0-9_]+$"))]
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("enum" = [1, 2, 3, 4, 5]))]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<Receipt>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub struct SuccessEnvelope {
    #[schemars(extend("const" = 1))]
    pub schema_version: u64,
    #[schemars(extend("const" = true))]
    pub ok: bool,
    pub data: Reply,
}

impl Envelope {
    pub fn failure(error: FailureError) -> Self {
        Self::Failure(Box::new(FailureEnvelope {
            schema_version: SCHEMA_VERSION,
            ok: false,
            error,
        }))
    }

    pub fn success(data: Reply) -> Self {
        Self::Success(Box::new(SuccessEnvelope {
            schema_version: SCHEMA_VERSION,
            ok: true,
            data,
        }))
    }
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
#[schemars(inline)]
pub enum Reply {
    Workflow(Workflow),
    ProviderQuota(ProviderQuotaReply),
    QuotaWake(QuotaWakeReply),
    WakeConfigured(WakeConfiguredReply),
    Operation(OperationReply),
    Events(EventsReply),
    Session(SessionReply),
    Sessions(SessionsReply),
    Providers(ProvidersReply),
    SessionRead(SessionReadReply),
    Diff(DiffReply),
    ReviewOpened(ReviewOpenedReply),
    ReviewDelivered(ReviewDeliveredReply),
    Recovery(RecoveryReply),
    Created(CreatedReply),
    SessionHibernation(SessionHibernationReply),
    WorktreeSetup(WorktreeSetupReply),
    WorktreeSetupApproved(WorktreeSetupApprovedReply),
    WorktreeSetupRevoked(WorktreeSetupRevokedReply),
    WorktreeRunStarted(WorktreeRunStartedReply),
    WorktreeCancelled(WorktreeCancelledReply),
    WorktreeArchived(WorktreeArchivedReply),
    WorktreeRegistry(WorktreeRegistryReply),
    AttentionInbox(AttentionInboxReply),
    InboxAcknowledged(InboxAcknowledgedReply),
    Decisions(DecisionsReply),
    Decided(DecidedReply),
    Projects(ProjectsReply),
    ProjectPinned(ProjectPinnedReply),
    ProjectLayout(ProjectLayoutReply),
    ProjectDefaults(ProjectDefaultsReply),
    WorkflowTemplates(WorkflowTemplatesReply),
    WorkflowTemplatesApproved(WorkflowTemplatesApprovedReply),
    WorkflowTemplatesRevoked(WorkflowTemplatesRevokedReply),
    WorkflowTemplateStarted(WorkflowTemplateStartedReply),
    McpPool(McpPoolReply),
    McpServers(McpServersReply),
}

impl Reply {
    pub fn from_host(mut value: Value) -> serde_json::Result<Self> {
        if let Some(object) = value.as_object_mut() {
            object.remove("requestId");
        }
        serde_json::from_value(value)
    }
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "id")]
pub struct Id(#[schemars(length(min = 1, max = 128))] pub String);

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "cursor")]
pub struct Cursor(pub u64);

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "timestamp", description = "Unix time in milliseconds.")]
pub struct Timestamp(pub u64);

fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

fn present_or_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

const NULLABLE_MARKER: &str = "x-nesvo-nullable";

fn nullable(schema: &mut Schema) {
    schema.insert(NULLABLE_MARKER.into(), true.into());
}

fn one_of(schema: &mut Schema) {
    if let Some(branches) = schema.remove("anyOf") {
        schema.insert("oneOf".into(), branches);
    }
}

fn workflow_tag(schema: &mut Schema) {
    if let Some(Value::Object(properties)) = schema.get_mut("properties") {
        properties.insert(
            "type".into(),
            serde_json::json!({"type": "string", "const": "workflow"}),
        );
    }
}

#[cfg(test)]
pub(crate) mod contract {
    use super::*;
    use schemars::{
        generate::SchemaSettings,
        transform::{RecursiveTransform, RestrictFormats},
    };

    const ID: &str = "urn:nesvo:cli-query:v1";
    const TITLE: &str = "Nesvo headless query output v1";

    pub fn schema() -> Value {
        let mut schema = SchemaSettings::draft07()
            .for_serialize()
            .with_transform(RestrictFormats::default())
            .with_transform(RecursiveTransform(contract_shape))
            .into_generator()
            .into_root_schema_for::<Envelope>();
        schema.insert("$id".into(), ID.into());
        schema.insert("title".into(), TITLE.into());
        schema.to_value()
    }

    fn contract_shape(schema: &mut Schema) {
        let Some(object) = schema.as_object_mut() else {
            return;
        };
        for key in ["additionalProperties", "items"] {
            if object.get(key) == Some(&Value::Bool(true)) {
                object.remove(key);
            }
        }
        if object.contains_key("const") {
            object.remove("minimum");
        }
        if let Some(Value::Array(branches)) = object.get_mut("anyOf") {
            branches.sort_by_key(|branch| branch != &serde_json::json!({"type": "null"}));
        }
        let required = object.get("required").cloned().unwrap_or_default();
        let Some(Value::Object(properties)) = object.get_mut("properties") else {
            return;
        };
        for (name, property) in properties.iter_mut() {
            let Value::Object(property) = property else {
                continue;
            };
            let nullable = property.remove(NULLABLE_MARKER).is_some();
            let optional = !required
                .as_array()
                .is_some_and(|required| required.iter().any(|field| field == name));
            if optional && !nullable {
                omit_null(property);
            }
        }
    }

    const REGENERATE: &str = "NESVO_UPDATE_CONTRACTS=1 cargo test -p nesvo --bin nesvo cli_replies";
    const SCHEMA_PATH: &str = "docs/harness-cli.schema.json";

    fn repository_file(path: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(path)
    }

    #[test]
    fn cli_schema_matches_the_checked_in_contract() {
        let expected = nesvo_wire::contract::render_json(&schema());
        let path = repository_file(SCHEMA_PATH);
        if std::env::var("NESVO_UPDATE_CONTRACTS").as_deref() == Ok("1") {
            std::fs::write(&path, &expected).unwrap();
            return;
        }
        let current = std::fs::read_to_string(&path)
            .unwrap()
            .replace("\r\n", "\n");
        assert!(
            current == expected,
            "{SCHEMA_PATH} drifted from the reply types; regenerate it with {REGENERATE}"
        );
    }

    const ENVELOPES_PATH: &str = "tests/fixtures/harness-cli-envelopes.json";

    #[test]
    fn captured_envelopes_round_trip_through_the_reply_types() {
        let envelopes: Vec<Value> = serde_json::from_str(
            &std::fs::read_to_string(repository_file(ENVELOPES_PATH)).unwrap(),
        )
        .unwrap();
        assert!(!envelopes.is_empty());
        for (index, envelope) in envelopes.into_iter().enumerate() {
            let typed: Envelope = serde_json::from_value(envelope.clone())
                .unwrap_or_else(|error| panic!("Envelope {index}: {error}"));
            assert_eq!(
                serde_json::to_value(&typed).unwrap(),
                envelope,
                "Envelope {index} changed through the reply types"
            );
        }
    }

    fn omit_null(property: &mut Map<String, Value>) {
        if let Some(Value::Array(types)) = property.get_mut("type") {
            types.retain(|kind| kind != "null");
            if let [kind] = types.as_slice() {
                let kind = kind.clone();
                property.insert("type".into(), kind);
            }
        }
        if let Some(Value::Array(values)) = property.get_mut("enum") {
            values.retain(|value| !value.is_null());
        }
        if let Some(Value::Array(branches)) = property.get_mut("anyOf") {
            branches.retain(|branch| branch != &serde_json::json!({"type": "null"}));
            if let [branch] = branches.as_slice() {
                let Value::Object(branch) = branch.clone() else {
                    return;
                };
                property.remove("anyOf");
                property.extend(branch);
            }
        }
    }
}
