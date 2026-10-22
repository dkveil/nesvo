use nesvo_wire::{
    contract::render_json,
    events::{journaled_kind, schema},
};
use serde_json::Value;
use std::{fs, path::PathBuf};

const REGENERATE: &str = "NESVO_UPDATE_CONTRACTS=1 cargo test -p nesvo-wire --test event_contracts";
const KINDS_START: &str = "<!-- generated:event-kinds:start -->";
const KINDS_END: &str = "<!-- generated:event-kinds:end -->";

fn repository_file(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path)
}

fn updating() -> bool {
    std::env::var_os("NESVO_UPDATE_CONTRACTS").is_some_and(|value| value == "1")
}

fn check_contract(path: &str, expected: &str) {
    let path = repository_file(path);
    if updating() {
        fs::write(&path, expected).unwrap();
        return;
    }
    let current = fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
    assert!(
        current == expected,
        "{} is stale; regenerate it with {REGENERATE}",
        path.display()
    );
}

#[test]
fn event_schema_matches_the_checked_in_contract() {
    let schema = schema();
    assert_eq!(schema["$schema"], "http://json-schema.org/draft-07/schema#");
    check_contract("docs/harness-events.schema.json", &render_json(&schema));
}

fn definition<'a>(definitions: &'a Value, reference: &Value) -> &'a Value {
    &definitions[reference
        .as_str()
        .unwrap()
        .trim_start_matches("#/definitions/")]
}

fn field_type(schema: &Value) -> String {
    if let Some(reference) = schema["$ref"].as_str() {
        return reference.trim_start_matches("#/definitions/").to_owned();
    }
    let types: Vec<_> = match &schema["type"] {
        Value::Array(types) => types.iter().map(|kind| kind.as_str().unwrap()).collect(),
        kind => vec![kind.as_str().unwrap()],
    };
    types
        .into_iter()
        .map(|kind| match kind {
            "array" => format!("array of {}", field_type(&schema["items"])),
            kind => kind.to_owned(),
        })
        .collect::<Vec<_>>()
        .join(" or ")
}

fn payload_fields(payload: &Value) -> String {
    let empty = serde_json::Map::new();
    let properties = payload["properties"].as_object().unwrap_or(&empty);
    let required: Vec<_> = payload["required"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|name| name.as_str().unwrap())
        .collect();
    let optional = properties
        .keys()
        .map(String::as_str)
        .filter(|name| !required.contains(name))
        .map(|name| (name, ", optional"));
    let fields: Vec<_> = required
        .iter()
        .map(|name| (*name, ""))
        .chain(optional)
        .map(|(name, presence)| format!("`{name}` {}{presence}", field_type(&properties[name])))
        .collect();
    if fields.is_empty() {
        "none".into()
    } else {
        fields.join("; ")
    }
}

fn table_line(cells: &[String], widths: &[usize]) -> String {
    let cells: Vec<_> = cells
        .iter()
        .zip(widths)
        .map(|(cell, width)| format!("{cell:width$}"))
        .collect();
    format!("| {} |", cells.join(" | "))
}

fn table(rows: &[Vec<String>]) -> String {
    let widths: Vec<_> = (0..rows[0].len())
        .map(|column| {
            rows.iter()
                .map(|row| row[column].len())
                .max()
                .unwrap()
                .max(3)
        })
        .collect();
    let rule: Vec<_> = widths.iter().map(|width| "-".repeat(*width)).collect();
    let mut lines = vec![table_line(&rows[0], &widths), table_line(&rule, &widths)];
    lines.extend(rows[1..].iter().map(|row| table_line(row, &widths)));
    lines.join("\n")
}

fn kind_section() -> String {
    let schema = schema();
    let definitions = &schema["definitions"];
    let mut rows = vec![vec![
        "Kind".to_owned(),
        "Payload fields".to_owned(),
        "Journaled".to_owned(),
    ]];
    for variant in schema["oneOf"].as_array().unwrap() {
        let kind = variant["properties"]["kind"]["const"].as_str().unwrap();
        let payload = definition(definitions, &variant["properties"]["payload"]["$ref"]);
        rows.push(vec![
            format!("`{kind}`"),
            payload_fields(payload),
            if journaled_kind(kind) { "yes" } else { "no" }.to_owned(),
        ]);
    }
    let enums: Vec<_> = definitions
        .as_object()
        .unwrap()
        .iter()
        .filter_map(|(name, definition)| {
            let values: Vec<_> = definition["enum"]
                .as_array()?
                .iter()
                .map(|value| format!("`{}`", value.as_str().unwrap()))
                .collect();
            Some(format!("- `{name}`: {}.", values.join(", ")))
        })
        .collect();
    [
        "This table is generated from `nesvo_wire::events::Event`, which the host uses for every",
        "append, together with [harness-events.schema.json](harness-events.schema.json). Regenerate",
        &format!("both with `{REGENERATE}`;"),
        "CI fails when either drifts. Each record carries `sequence`, `sessionId`, `kind`, `at` and",
        "`payload`. A kind marked `no` fails the journal kind rule (lowercase letters, `.` and `_`) and",
        "is never persisted.",
        "",
        &table(&rows),
        "",
        "Enumerated payload types:",
        "",
        &enums.join("\n"),
    ]
    .join("\n")
}

fn between_markers(document: &str, content: &str) -> String {
    let start = document
        .find(KINDS_START)
        .unwrap_or_else(|| panic!("docs/harness-events.md lost the {KINDS_START} marker"));
    let end = document[start..]
        .find(KINDS_END)
        .map(|offset| start + offset)
        .unwrap_or_else(|| panic!("docs/harness-events.md lost the {KINDS_END} marker"));
    format!(
        "{}{KINDS_START}\n\n{content}\n\n{}",
        &document[..start],
        &document[end..]
    )
}

#[test]
fn event_kind_table_matches_the_harness_events_doc() {
    let path = "docs/harness-events.md";
    let current = fs::read_to_string(repository_file(path))
        .unwrap()
        .replace("\r\n", "\n");
    check_contract(path, &between_markers(&current, &kind_section()));
}

#[test]
fn regeneration_keeps_prose_after_the_generated_block() {
    let document =
        format!("## Event kinds\n\n{KINDS_START}\n\nold\n\n{KINDS_END}\n\n## Later\n\nKept.\n");
    assert_eq!(
        between_markers(&document, "new"),
        format!("## Event kinds\n\n{KINDS_START}\n\nnew\n\n{KINDS_END}\n\n## Later\n\nKept.\n")
    );
}
