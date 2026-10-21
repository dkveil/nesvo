use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const STORE_BYTES: usize = 64 * 1024;
pub const OPERATION_BYTES: usize = 8192;
pub const PASTE_BYTES: usize = 32 * 1024;
const TEXT_CHARS: usize = 4000;
const PATH_BYTES: usize = 4096;
const REVIEW_ID_BYTES: usize = 160;
const SNIPPET_LINES: usize = 6;
const SNIPPET_LINE_CHARS: usize = 160;
const MARKER_RESERVE: usize = 160;
pub const DEFAULT_PREFIX: &str = "Please address these review comments.";
const EMPTY_TEXT: &str = "Write something before saving the comment.";
const FULL_STORE: &str = "Review notes are limited to 64 KiB; shorten or delete a comment.";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Old,
    #[default]
    New,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub path: String,
    pub side: Side,
    pub start: usize,
    pub end: usize,
    pub snippet: String,
    pub revision: String,
}

impl Anchor {
    pub fn location(&self) -> String {
        let lines = if self.start == self.end {
            self.start.to_string()
        } else {
            format!("{}-{}", self.start, self.end)
        };
        match self.side {
            Side::New => format!("{}:{lines}", self.path),
            Side::Old => format!("{}:{lines} (removed lines)", self.path),
        }
    }

    pub fn covers(&self, path: &str, side: Side, line: usize) -> bool {
        self.path == path && self.side == side && (self.start..=self.end).contains(&line)
    }

    fn valid(&self) -> bool {
        !self.path.is_empty()
            && self.path.len() <= PATH_BYTES
            && !self.path.chars().any(char::is_control)
            && self.start <= self.end
            && !self.revision.is_empty()
            && self.revision.len() <= 128
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: u64,
    pub anchor: Anchor,
    pub text: String,
    #[serde(default)]
    pub drifted: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Comments {
    pub summary: String,
    pub comments: Vec<Comment>,
    next_id: u64,
}

pub fn snippet<'a>(lines: impl IntoIterator<Item = &'a str>) -> String {
    lines
        .into_iter()
        .take(SNIPPET_LINES)
        .map(|line| {
            clean(line, false)
                .chars()
                .take(SNIPPET_LINE_CHARS)
                .collect()
        })
        .collect::<Vec<String>>()
        .join("\n")
}

fn clean(text: &str, multiline: bool) -> String {
    text.chars()
        .map(|c| match c {
            '\n' if multiline => '\n',
            '\t' => '\t',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect()
}

fn normalized_text(text: &str) -> Result<String, &'static str> {
    let text: String = clean(text.trim(), true).chars().take(TEXT_CHARS).collect();
    if text.trim().is_empty() {
        return Err(EMPTY_TEXT);
    }
    Ok(text)
}

impl Comments {
    pub fn add(&mut self, anchor: Anchor, text: &str) -> Result<u64, &'static str> {
        let text = normalized_text(text)?;
        let id = self.next_id.max(1);
        let before = self.clone();
        self.next_id = id + 1;
        self.comments.push(Comment {
            id,
            anchor,
            text,
            drifted: false,
        });
        self.comments.sort_by(|a, b| {
            (&a.anchor.path, a.anchor.start).cmp(&(&b.anchor.path, b.anchor.start))
        });
        self.keep_within(before).map(|()| id)
    }

    pub fn edit(&mut self, id: u64, text: &str) -> Result<(), &'static str> {
        let text = normalized_text(text)?;
        let before = self.clone();
        let Some(comment) = self.comments.iter_mut().find(|c| c.id == id) else {
            return Err("That comment no longer exists.");
        };
        comment.text = text;
        self.keep_within(before)
    }

    pub fn delete(&mut self, id: u64) -> bool {
        let count = self.comments.len();
        self.comments.retain(|comment| comment.id != id);
        count != self.comments.len()
    }

    pub fn set_summary(&mut self, text: &str) -> Result<(), &'static str> {
        let before = self.clone();
        self.summary = clean(text.trim(), true).chars().take(TEXT_CHARS).collect();
        self.keep_within(before)
    }

    pub fn find(&self, id: u64) -> Option<&Comment> {
        self.comments.iter().find(|comment| comment.id == id)
    }

    pub fn is_empty(&self) -> bool {
        self.comments.is_empty() && self.summary.is_empty()
    }

    pub fn drifted(&self) -> usize {
        self.comments.iter().filter(|c| c.drifted).count()
    }

    pub fn rebase(
        &mut self,
        revision: &str,
        locate: impl Fn(&Anchor) -> Option<(usize, usize)>,
    ) -> bool {
        let mut changed = false;
        for comment in &mut self.comments {
            if comment.anchor.revision == revision {
                continue;
            }
            match locate(&comment.anchor) {
                Some((start, end)) => {
                    comment.anchor.start = start;
                    comment.anchor.end = end;
                    comment.anchor.revision = revision.to_owned();
                    comment.drifted = false;
                }
                None => comment.drifted = true,
            }
            changed = true;
        }
        changed
    }

    fn keep_within(&mut self, before: Self) -> Result<(), &'static str> {
        if self.encode().len() > STORE_BYTES {
            *self = before;
            return Err(FULL_STORE);
        }
        Ok(())
    }

    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "version": 1,
            "summary": self.summary,
            "nextId": self.next_id,
            "comments": self.comments,
        }))
        .unwrap_or_default()
    }

    pub fn decode(bytes: &[u8]) -> Self {
        if bytes.len() > STORE_BYTES {
            return Self::default();
        }
        let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
            return Self::default();
        };
        let mut comments: Vec<Comment> = Vec::new();
        for entry in value["comments"].as_array().into_iter().flatten() {
            let Ok(mut comment) = serde_json::from_value::<Comment>(entry.clone()) else {
                continue;
            };
            let Ok(text) = normalized_text(&comment.text) else {
                continue;
            };
            if !comment.anchor.valid()
                || comment.id == 0
                || comments.iter().any(|known| known.id == comment.id)
            {
                continue;
            }
            comment.text = text;
            comment.anchor.snippet = snippet(comment.anchor.snippet.lines());
            comments.push(comment);
        }
        let next_id = value["nextId"]
            .as_u64()
            .unwrap_or(1)
            .max(comments.iter().map(|c| c.id + 1).max().unwrap_or(1));
        Self {
            summary: value["summary"]
                .as_str()
                .map(|text| clean(text.trim(), true).chars().take(TEXT_CHARS).collect())
                .unwrap_or_default(),
            comments,
            next_id,
        }
    }

    pub fn load(path: &Path) -> Self {
        match fs::metadata(path) {
            Ok(metadata) if metadata.len() <= STORE_BYTES as u64 => {
                fs::read(path).map_or_else(|_| Self::default(), |bytes| Self::decode(&bytes))
            }
            _ => Self::default(),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let bytes = self.encode();
        ensure!(bytes.len() <= STORE_BYTES, "Review notes are too large");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
        fs::write(&temporary, bytes)?;
        fs::rename(temporary, path)?;
        Ok(())
    }
}

pub fn valid_review_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= REVIEW_ID_BYTES
        && !id.starts_with(['.', '-'])
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

pub fn store_path(directory: &Path, review_id: &str) -> Option<PathBuf> {
    valid_review_id(review_id).then(|| directory.join(format!("review-{review_id}.json")))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Document {
    pub text: String,
    pub included: usize,
    pub total: usize,
    pub cap: usize,
    pub clipped: bool,
}

impl Document {
    pub fn truncated(&self) -> bool {
        self.clipped || self.included < self.total
    }
}

fn block(index: usize, comment: &Comment) -> String {
    let mut block = format!("\n{}. {}", index + 1, comment.anchor.location());
    if comment.drifted {
        block.push_str(" (code changed since this comment)");
    }
    block.push('\n');
    for line in comment.anchor.snippet.lines() {
        block.push_str("> ");
        block.push_str(line);
        block.push('\n');
    }
    block.push_str(&comment.text);
    block.push('\n');
    block
}

fn cut(text: &str, bytes: usize) -> &str {
    let mut end = bytes.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

pub fn document(comments: &Comments, cap: usize) -> Document {
    let total = comments.comments.len();
    let head = if comments.summary.is_empty() {
        DEFAULT_PREFIX
    } else {
        comments.summary.as_str()
    };
    let room = cap.saturating_sub(MARKER_RESERVE);
    let clipped = head.len() + 1 > room;
    let mut text = if clipped {
        format!("{}…\n", cut(head, room.saturating_sub(4)))
    } else {
        format!("{head}\n")
    };
    let mut included = 0;
    for (index, comment) in comments.comments.iter().enumerate() {
        let next = block(index, comment);
        let limit = if index + 1 == total { cap } else { room };
        if text.len() + next.len() > limit {
            break;
        }
        text.push_str(&next);
        included += 1;
    }
    if included < total {
        let marker = format!(
            "\n[{} of {total} comments omitted: the review is limited to {cap} bytes]\n",
            total - included
        );
        text.push_str(cut(&marker, cap.saturating_sub(text.len())));
    }
    Document {
        text,
        included,
        total,
        cap,
        clipped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor(path: &str, start: usize, end: usize, snippet: &str) -> Anchor {
        Anchor {
            path: path.into(),
            side: Side::New,
            start,
            end,
            snippet: snippet.into(),
            revision: "rev-1".into(),
        }
    }

    #[test]
    fn review_comments_add_edit_delete_and_refuse_empty_or_oversized_notes() {
        let mut notes = Comments::default();
        assert_eq!(
            notes.add(anchor("a.rs", 3, 3, "x"), "  \n "),
            Err(EMPTY_TEXT)
        );
        let second = notes.add(anchor("b.rs", 1, 2, "y"), "Second").unwrap();
        let first = notes.add(anchor("a.rs", 9, 9, "z"), "First\u{7}").unwrap();
        assert_eq!(notes.comments[0].id, first);
        assert_eq!(notes.comments[0].text, "First ");
        notes.edit(second, "Changed").unwrap();
        assert_eq!(notes.find(second).unwrap().text, "Changed");
        assert_eq!(notes.edit(99, "x"), Err("That comment no longer exists."));
        assert!(notes.delete(first) && !notes.delete(first));
        notes.set_summary("Overall fine").unwrap();
        let saved = notes.clone();
        let mut refused = 0;
        for index in 0..100 {
            if notes
                .add(anchor("c.rs", index, index, "s"), &"w".repeat(3000))
                .is_err()
            {
                refused += 1;
            }
        }
        assert!(refused > 0 && notes.encode().len() <= STORE_BYTES);
        assert_eq!(notes.find(second), saved.find(second));
        assert_eq!(
            notes.add(anchor("c.rs", 1, 1, "s"), &"w".repeat(3000)),
            Err(FULL_STORE)
        );
    }

    #[test]
    fn review_comments_drift_relocates_moved_snippets_and_marks_missing_ones() {
        let mut notes = Comments::default();
        let kept = notes.add(anchor("a.rs", 4, 5, "keep"), "Keep").unwrap();
        let moved = notes.add(anchor("a.rs", 10, 10, "move"), "Move").unwrap();
        let gone = notes.add(anchor("b.rs", 2, 2, "gone"), "Gone").unwrap();
        assert!(!notes.rebase("rev-1", |_| None));
        let changed = notes.rebase("rev-2", |anchor| match anchor.snippet.as_str() {
            "keep" => Some((4, 5)),
            "move" => Some((14, 14)),
            _ => None,
        });
        assert!(changed);
        let find = |id| notes.find(id).unwrap().clone();
        assert!(!find(kept).drifted && find(kept).anchor.revision == "rev-2");
        assert_eq!((find(moved).anchor.start, find(moved).drifted), (14, false));
        assert!(find(gone).drifted && find(gone).anchor.revision == "rev-1");
        assert_eq!(notes.drifted(), 1);
        notes.rebase("rev-3", |anchor| {
            (anchor.snippet == "gone").then_some((7, 7))
        });
        assert!(!notes.find(gone).unwrap().drifted);
        assert_eq!(notes.find(gone).unwrap().anchor.start, 7);
    }

    #[test]
    fn review_document_puts_summary_first_and_respects_both_caps() {
        let mut notes = Comments::default();
        notes
            .add(
                anchor("src/a.rs", 12, 14, "let a = 1;\nlet b = 2;"),
                "Rename these.",
            )
            .unwrap();
        let text = document(&notes, OPERATION_BYTES).text;
        assert!(text.starts_with(DEFAULT_PREFIX));
        assert!(text.contains("1. src/a.rs:12-14\n> let a = 1;\n> let b = 2;\nRename these.\n"));
        notes.set_summary("Looks close; fix the naming.").unwrap();
        let mut old = anchor("src/b.rs", 3, 3, "gone();");
        old.side = Side::Old;
        notes.add(old, "Why removed?").unwrap();
        notes.comments[1].drifted = true;
        let full = document(&notes, OPERATION_BYTES);
        assert!(full.text.starts_with("Looks close; fix the naming.\n"));
        assert!(
            full.text
                .contains("src/b.rs:3 (removed lines) (code changed since this comment)")
        );
        assert!(!full.truncated());
        for index in 0..40 {
            notes
                .add(
                    anchor("src/c.rs", index + 20, index + 20, "line"),
                    &"x".repeat(900),
                )
                .unwrap();
        }
        for cap in [OPERATION_BYTES, PASTE_BYTES] {
            let document = document(&notes, cap);
            assert!(document.text.len() <= cap, "{cap}");
            assert!(document.truncated());
            assert!(document.included > 0 && document.included < document.total);
            assert!(
                document
                    .text
                    .contains("comments omitted: the review is limited to")
            );
            assert!(document.text.starts_with("Looks close"));
        }
        assert!(
            document(&notes, PASTE_BYTES).included > document(&notes, OPERATION_BYTES).included
        );
        let mut long = Comments::default();
        long.set_summary(&"ż".repeat(3000)).unwrap();
        long.add(anchor("a", 1, 1, "s"), "t").unwrap();
        let short = document(&long, 1024);
        assert!(short.text.len() <= 1024 && short.truncated());
    }

    #[test]
    fn review_store_round_trips_atomically_and_loads_leniently() {
        let directory = std::env::temp_dir().join(format!(
            "nesvo-review-store-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        assert!(store_path(&directory, "../escape").is_none());
        assert!(store_path(&directory, "").is_none());
        let path = store_path(&directory, "pull-dkveil-nesvo-12").unwrap();
        assert!(path.ends_with("review-pull-dkveil-nesvo-12.json"));
        assert_eq!(Comments::load(&path), Comments::default());
        let mut notes = Comments::default();
        notes.set_summary("Summary").unwrap();
        let id = notes.add(anchor("a.rs", 1, 2, "x"), "Note").unwrap();
        notes.save(&path).unwrap();
        let loaded = Comments::load(&path);
        assert_eq!(loaded, notes);
        let mut next = loaded.clone();
        assert!(next.add(anchor("a.rs", 3, 3, "y"), "Again").unwrap() > id);
        let lenient = Comments::decode(
            br#"{"summary":"S","nextId":"bad","comments":[
                {"id":4,"anchor":{"path":"a.rs","side":"new","start":1,"end":1,"snippet":"x","revision":"r"},"text":"ok"},
                {"id":4,"anchor":{"path":"a.rs","side":"new","start":1,"end":1,"snippet":"x","revision":"r"},"text":"dup"},
                {"id":5,"anchor":{"path":"","side":"new","start":1,"end":1,"snippet":"x","revision":"r"},"text":"bad"},
                {"id":6,"anchor":{"path":"b.rs","side":"old","start":3,"end":2,"snippet":"x","revision":"r"},"text":"bad"},
                {"id":7,"text":"no anchor"}, 12]}"#,
        );
        assert_eq!(lenient.summary, "S");
        assert_eq!(lenient.comments.len(), 1);
        assert_eq!(lenient.next_id, 5);
        assert_eq!(Comments::decode(b"not json"), Comments::default());
        fs::write(&path, vec![b' '; STORE_BYTES + 1]).unwrap();
        assert_eq!(Comments::load(&path), Comments::default());
        let _ = fs::remove_dir_all(directory);
    }
}
