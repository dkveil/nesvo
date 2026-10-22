use nesvo_wire::views::{
    self, HostError, ReplyHeader,
    notes::{DeleteNote, ListNotes, NoteList, NoteText, ReadNote, StaleNote, WriteNote},
};
use serde_json::{Value, json};

fn reply(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

const LIST: &str = r##"{"type":"notes","requestId":"tui-1-4","root":"/w","directory":"/w/.nesvo/notes",
  "location":"repository","repository":"/w","truncated":false,"notes":[
  {"name":"plan.md","path":"/w/.nesvo/notes/plan.md","size":12,"modifiedMs":5,"firstLine":"# Plan"},
  {"name":"ideas.md","path":"/w/.nesvo/notes/ideas.md","size":3,"modifiedMs":null,"firstLine":""}]}"##;

#[test]
fn note_list_reads_the_folder_and_its_summaries() {
    let event = reply(LIST);
    let header = ReplyHeader::of(&event);
    assert_eq!(header.kind.as_deref(), Some("notes"));
    assert_eq!(header.request_id.as_deref(), Some("tui-1-4"));
    let list = views::decode::<NoteList>(&event).unwrap();
    assert_eq!(list.directory, "/w/.nesvo/notes");
    assert_eq!(list.location, "repository");
    assert_eq!(list.repository.as_deref(), Some("/w"));
    assert!(!list.truncated);
    let notes: Vec<_> = list.notes.into_iter().filter_map(|note| note.0).collect();
    assert_eq!(notes[0].first_line, "# Plan");
    assert_eq!(notes[0].modified_ms, Some(5));
    assert_eq!(notes[1].modified_ms, None);
}

#[test]
fn host_notes_skip_a_malformed_summary_and_default_a_missing_repository() {
    let mut event = reply(LIST);
    event["location"] = json!("host");
    event["repository"] = Value::Null;
    event["notes"][0]["path"] = json!(7);
    event["notes"][1]["size"] = json!("big");
    let list = views::decode::<NoteList>(&event).unwrap();
    assert_eq!(list.location, "host");
    assert!(list.repository.is_none());
    assert!(list.notes[0].0.is_none());
    assert_eq!(list.notes[1].0.as_ref().unwrap().size, 0);
}

#[test]
fn note_text_reads_reads_and_saves() {
    let read = views::decode::<NoteText>(&json!({"type":"note","path":"/n/a.md","name":"a.md",
        "text":"hello","size":5,"modifiedMs":9,"revision":"abc"}))
    .unwrap();
    assert_eq!(
        (read.text.as_str(), read.revision.as_str(), read.size),
        ("hello", "abc", 5)
    );
    let saved =
        views::decode::<NoteText>(&json!({"type":"noteSaved","path":"/n/b.md","name":"b.md",
        "revision":"def","size":2,"modifiedMs":null,"created":true}))
        .unwrap();
    assert_eq!(saved.path, "/n/b.md");
    assert_eq!(saved.text, "");
    assert_eq!(saved.modified_ms, None);
}

#[test]
fn stale_revision_errors_carry_the_current_revision_or_null() {
    let stale = json!({"type":"error","requestId":"r","code":"stale_revision","message":"changed","revision":"abc"});
    assert_eq!(HostError::of(&stale).code(), "stale_revision");
    assert_eq!(
        views::decode::<StaleNote>(&stale)
            .unwrap()
            .revision
            .as_deref(),
        Some("abc")
    );
    let gone = json!({"type":"error","code":"stale_revision","message":"gone","revision":null});
    assert_eq!(views::decode::<StaleNote>(&gone).unwrap().revision, None);
}

#[test]
fn note_requests_keep_their_wire_shape() {
    assert_eq!(
        views::encode(&ListNotes { root: "/w" }),
        json!({"type":"listNotes","root":"/w"})
    );
    assert_eq!(
        views::encode(&ReadNote { path: "/n/a.md" }),
        json!({"type":"readNote","path":"/n/a.md"})
    );
    assert_eq!(
        views::encode(&WriteNote {
            path: "/n/a.md",
            text: "x",
            expected_revision: None
        }),
        json!({"type":"writeNote","path":"/n/a.md","text":"x","expectedRevision":null})
    );
    assert_eq!(
        views::encode(&WriteNote {
            path: "/n/a.md",
            text: "x",
            expected_revision: Some("abc")
        })["expectedRevision"],
        "abc"
    );
    assert_eq!(
        views::encode(&DeleteNote { path: "/n/a.md" }),
        json!({"type":"deleteNote","path":"/n/a.md"})
    );
}
