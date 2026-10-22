use nesvo_wire::views::{
    self, Tolerant,
    layouts::{ReleaseControl, Subscribe, Unsubscribe},
    lenient,
};
use serde::Deserialize;
use serde_json::json;

#[test]
fn pane_commands_serialize_to_the_host_command_shapes() {
    assert_eq!(
        views::encode(&Subscribe { session_id: "s" }),
        json!({"type":"subscribe","sessionId":"s"})
    );
    assert_eq!(
        views::encode(&Unsubscribe { session_id: "s" }),
        json!({"type":"unsubscribe","sessionId":"s"})
    );
    assert_eq!(
        views::encode(&ReleaseControl {
            session_id: "s",
            lease_id: "l"
        }),
        json!({"type":"releaseControl","sessionId":"s","leaseId":"l"})
    );
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Saved {
    #[serde(deserialize_with = "lenient")]
    panes: Vec<Option<String>>,
    items: Vec<Tolerant<u8>>,
}

#[test]
fn lenient_fields_and_tolerant_items_survive_damaged_saved_state() {
    let saved: Saved =
        serde_json::from_value(json!({"panes":"broken","items":[1,"two",300,4]})).unwrap();
    assert!(saved.panes.is_empty());
    let items: Vec<_> = saved.items.into_iter().map(|item| item.0).collect();
    assert_eq!(items, [Some(1), None, None, Some(4)]);
}
