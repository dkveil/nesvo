use super::lenient;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    File,
    Dir,
    Symlink,
    #[serde(other)]
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub kind: FileKind,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub ignored: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Entries {
    pub entries: Vec<FileEntry>,
    #[serde(default, deserialize_with = "lenient")]
    pub truncated: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct FileChunk {
    #[serde(default, deserialize_with = "lenient")]
    pub offset: u64,
    #[serde(default, deserialize_with = "lenient")]
    pub length: u64,
    #[serde(default, deserialize_with = "lenient")]
    pub text: String,
    #[serde(default, deserialize_with = "lenient")]
    pub size: u64,
    #[serde(default, deserialize_with = "lenient")]
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct FileMatch {
    pub path: String,
    #[serde(default)]
    pub score: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct FoundFiles {
    #[serde(default, deserialize_with = "lenient")]
    pub matches: Vec<FileMatch>,
    #[serde(default, deserialize_with = "lenient")]
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "listEntries", rename_all = "camelCase")]
pub struct ListEntries<'a> {
    pub directory: &'a str,
    pub show_hidden: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "readFile")]
pub struct ReadFile<'a> {
    pub path: &'a str,
    pub offset: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "findFiles")]
pub struct FindFiles<'a> {
    pub root: &'a str,
    pub query: &'a str,
    pub limit: usize,
}
