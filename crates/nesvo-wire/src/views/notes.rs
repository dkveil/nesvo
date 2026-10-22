use super::{Tolerant, lenient};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub name: String,
    pub path: String,
    #[serde(default, deserialize_with = "lenient")]
    pub size: u64,
    #[serde(default, deserialize_with = "lenient")]
    pub modified_ms: Option<u64>,
    #[serde(default, deserialize_with = "lenient")]
    pub first_line: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct NoteList {
    #[serde(default, deserialize_with = "lenient")]
    pub directory: String,
    #[serde(default, deserialize_with = "lenient")]
    pub location: String,
    #[serde(default, deserialize_with = "lenient")]
    pub repository: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub notes: Vec<Tolerant<NoteSummary>>,
    #[serde(default, deserialize_with = "lenient")]
    pub truncated: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteText {
    #[serde(default, deserialize_with = "lenient")]
    pub path: String,
    #[serde(default, deserialize_with = "lenient")]
    pub text: String,
    #[serde(default, deserialize_with = "lenient")]
    pub revision: String,
    #[serde(default, deserialize_with = "lenient")]
    pub size: u64,
    #[serde(default, deserialize_with = "lenient")]
    pub modified_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct StaleNote {
    #[serde(default, deserialize_with = "lenient")]
    pub revision: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "listNotes")]
pub struct ListNotes<'a> {
    pub root: &'a str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "readNote")]
pub struct ReadNote<'a> {
    pub path: &'a str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "writeNote", rename_all = "camelCase")]
pub struct WriteNote<'a> {
    pub path: &'a str,
    pub text: &'a str,
    pub expected_revision: Option<&'a str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "deleteNote")]
pub struct DeleteNote<'a> {
    pub path: &'a str,
}
