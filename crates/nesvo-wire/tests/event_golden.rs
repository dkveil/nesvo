use nesvo_wire::events::{Event, EventRecord, journaled_kind};
use serde_json::Value;
use std::collections::BTreeSet;

fn golden() -> impl Iterator<Item = &'static str> {
    include_str!("fixtures/events.jsonl").lines()
}

fn payload_bytes(line: &str) -> &str {
    let start = line.find(",\"payload\":").unwrap() + ",\"payload\":".len();
    &line[start..line.len() - 1]
}

#[test]
fn every_event_kind_round_trips_its_golden_wire_record_byte_for_byte() {
    for line in golden() {
        let wire: Value = serde_json::from_str(line).unwrap();
        let kind = wire["kind"].as_str().unwrap();
        let record: EventRecord = serde_json::from_str(line)
            .unwrap_or_else(|error| panic!("{kind} does not decode: {error}"));
        assert_eq!(record.event.kind(), kind);
        assert_eq!(
            serde_json::to_string(&record.event.payload().unwrap()).unwrap(),
            payload_bytes(line),
            "{kind} payload bytes changed"
        );
        assert_eq!(
            serde_json::to_string(&serde_json::to_value(&record).unwrap()).unwrap(),
            serde_json::to_string(&wire).unwrap(),
            "{kind} record changed"
        );
        assert_eq!(
            journaled_kind(kind),
            record.sequence > 0,
            "{kind} journal admission changed"
        );
    }
}

#[test]
fn every_event_kind_has_a_golden_wire_record() {
    let captured: BTreeSet<_> = golden()
        .map(|line| serde_json::from_str::<Value>(line).unwrap()["kind"].clone())
        .map(|kind| kind.as_str().unwrap().to_owned())
        .collect();
    let modeled: BTreeSet<_> = Event::KINDS.iter().map(|kind| (*kind).to_owned()).collect();
    assert_eq!(captured, modeled);
}

#[test]
fn event_payload_rejects_unknown_fields_and_wrong_kinds() {
    let unknown = r#"{"sequence":1,"sessionId":null,"kind":"host.started","at":1,"payload":{"buildId":"b","extra":1}}"#;
    assert!(serde_json::from_str::<EventRecord>(unknown).is_err());
    let mismatched =
        r#"{"sequence":1,"sessionId":null,"kind":"run.created","at":1,"payload":{"buildId":"b"}}"#;
    assert!(serde_json::from_str::<EventRecord>(mismatched).is_err());
    let foreign = r#"{"sequence":1,"sessionId":null,"kind":"test.barrier","at":1,"payload":{}}"#;
    assert!(serde_json::from_str::<EventRecord>(foreign).is_err());
}
