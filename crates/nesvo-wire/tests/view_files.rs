use nesvo_wire::views::{
    self,
    files::{Entries, FileChunk, FileKind, FindFiles, FoundFiles, ListEntries, ReadFile},
};
use serde_json::{Value, json};

const ENTRIES: &str = r#"{"type":"entries","requestId":"tui-7-3","directory":"/work","root":"/work",
  "entries":[
    {"name":"src","kind":"dir","size":0,"modifiedMs":1,"status":null,"ignored":false},
    {"name":"link","kind":"symlink","size":0,"modifiedMs":null,"status":"M","ignored":false},
    {"name":"fifo","kind":"other","size":0,"modifiedMs":null,"status":null,"ignored":true},
    {"name":"a.txt","kind":"file","size":3,"modifiedMs":2,"status":"??","ignored":false}],
  "truncated":true,"statusTruncated":false}"#;

const FILE: &str = r#"{"type":"file","requestId":"tui-7-4","path":"/work/a.txt","size":9000,"offset":0,
  "length":4,"text":"abc\n","truncated":true,"encoding":"utf8"}"#;

const FOUND: &str = r#"{"type":"files","requestId":"tui-7-5","root":"/work","scanned":12,"truncated":false,
  "matches":[{"path":"src/main.rs","score":17},{"path":"src/lib.rs","score":9}]}"#;

fn reply(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

#[test]
fn entries_decode_kinds_status_and_truncation() {
    let listing = views::decode::<Entries>(&reply(ENTRIES)).unwrap();
    assert!(listing.truncated);
    let kinds: Vec<_> = listing.entries.iter().map(|entry| entry.kind).collect();
    assert_eq!(
        kinds,
        [
            FileKind::Dir,
            FileKind::Symlink,
            FileKind::Other,
            FileKind::File
        ]
    );
    assert_eq!(listing.entries[3].size, 3);
    assert_eq!(listing.entries[3].status.as_deref(), Some("??"));
    assert!(listing.entries[2].ignored);

    let mut grown = reply(ENTRIES);
    grown["entries"][0]["kind"] = json!("socket");
    assert_eq!(
        views::decode::<Entries>(&grown).unwrap().entries[0].kind,
        FileKind::Other
    );
    grown["entries"][0]["name"] = json!(7);
    assert!(views::decode::<Entries>(&grown).is_none());
    assert!(views::decode::<Entries>(&json!({"type":"entries","truncated":false})).is_none());
}

#[test]
fn file_chunks_and_matches_default_missing_fields() {
    let chunk = views::decode::<FileChunk>(&reply(FILE)).unwrap();
    assert_eq!((chunk.offset, chunk.length, chunk.size), (0, 4, 9000));
    assert_eq!(chunk.text, "abc\n");
    assert!(chunk.truncated);
    let sparse = views::decode::<FileChunk>(&json!({"type":"file","offset":"x"})).unwrap();
    assert_eq!(sparse, FileChunk::default());

    let found = views::decode::<FoundFiles>(&reply(FOUND)).unwrap();
    assert_eq!(found.matches[0].path, "src/main.rs");
    assert_eq!(found.matches[1].score, 9);
    let broken =
        views::decode::<FoundFiles>(&json!({"matches":[{"score":1}],"truncated":true})).unwrap();
    assert!(broken.matches.is_empty() && broken.truncated);
}

#[test]
fn file_requests_serialize_to_the_host_command_shapes() {
    assert_eq!(
        views::encode(&ListEntries {
            directory: "/work",
            show_hidden: false
        }),
        json!({"type":"listEntries","directory":"/work","showHidden":false})
    );
    assert_eq!(
        views::encode(&ReadFile {
            path: "/work/a.txt",
            offset: 65_536
        }),
        json!({"type":"readFile","path":"/work/a.txt","offset":65_536})
    );
    assert_eq!(
        views::encode(&FindFiles {
            root: "/work",
            query: "main",
            limit: 50
        }),
        json!({"type":"findFiles","root":"/work","query":"main","limit":50})
    );
}
