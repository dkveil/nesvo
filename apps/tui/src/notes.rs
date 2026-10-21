use serde::{Deserialize, Deserializer, Serialize, de::DeserializeOwned};
use serde_json::Value;

pub const NOTE_BYTES: usize = 64 * 1024;
pub const MAX_PROJECTS: usize = 32;
pub const MAX_CAPTURE_CHARS: usize = 400;
pub const MAX_QUERY_CHARS: usize = 120;
const MAX_PATH_BYTES: usize = 4096;
const MAX_SLUG_BYTES: usize = 100;
const TAB: &str = "    ";

fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned + Default,
{
    let value = Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LastNote {
    #[serde(deserialize_with = "lenient")]
    pub directory: String,
    #[serde(deserialize_with = "lenient")]
    pub name: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Saved {
    #[serde(deserialize_with = "lenient")]
    pub last: Vec<LastNote>,
}

impl Saved {
    pub fn sanitized(&self) -> Vec<LastNote> {
        let mut seen = Vec::new();
        self.last
            .iter()
            .filter(|entry| valid_directory(&entry.directory) && valid_name(&entry.name))
            .filter(|entry| {
                let fresh = !seen.contains(&entry.directory);
                seen.push(entry.directory.clone());
                fresh
            })
            .take(MAX_PROJECTS)
            .cloned()
            .collect()
    }
}

pub fn remember(last: &mut Vec<LastNote>, directory: &str, name: &str) {
    if !valid_directory(directory) || !valid_name(name) {
        return;
    }
    last.retain(|entry| entry.directory != directory);
    last.insert(
        0,
        LastNote {
            directory: directory.to_owned(),
            name: name.to_owned(),
        },
    );
    last.truncate(MAX_PROJECTS);
}

pub fn valid_directory(directory: &str) -> bool {
    !directory.is_empty()
        && directory.len() <= MAX_PATH_BYTES
        && !directory.chars().any(char::is_control)
}

pub fn valid_name(name: &str) -> bool {
    name.len() <= 128
        && name.len() > 3
        && name.ends_with(".md")
        && !name.starts_with('.')
        && !name.ends_with(' ')
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Summary {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
    pub first_line: String,
}

impl Summary {
    pub fn title(&self) -> &str {
        self.name.strip_suffix(".md").unwrap_or(&self.name)
    }

    pub fn heading(&self) -> &str {
        self.first_line.trim_start_matches('#').trim()
    }
}

pub fn matches(query: &str, summary: &Summary, content: Option<&str>) -> bool {
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    if words.is_empty() {
        return true;
    }
    let haystack = format!(
        "{}\n{}\n{}",
        summary.name,
        summary.first_line,
        content.unwrap_or_default()
    )
    .to_lowercase();
    words.iter().all(|word| haystack.contains(word.as_str()))
}

pub fn separator(directory: &str) -> char {
    if directory.contains('\\') && !directory.contains('/') {
        '\\'
    } else {
        '/'
    }
}

pub fn join(directory: &str, name: &str) -> String {
    let base = directory.trim_end_matches(['/', '\\']);
    format!("{base}{}{name}", separator(directory))
}

pub fn slug(text: &str) -> String {
    let heading = text
        .lines()
        .map(|line| line.trim_start_matches('#').trim())
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    let mut slug = String::new();
    for c in heading.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
        if slug.len() >= MAX_SLUG_BYTES {
            break;
        }
    }
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        "note".into()
    } else {
        slug.to_owned()
    }
}

pub fn unique_name(text: &str, taken: &[String]) -> String {
    let base = slug(text);
    let mut name = format!("{base}.md");
    let mut index = 2;
    while taken.iter().any(|known| known.eq_ignore_ascii_case(&name)) {
        name = format!("{base}-{index}.md");
        index += 1;
    }
    name
}

pub fn today_name(date: &str) -> String {
    format!("{date}.md")
}

pub fn captured(existing: Option<&str>, date: &str, time: &str, line: &str) -> String {
    let entry = format!("- {time} {}\n", line.trim());
    match existing {
        None => format!("# {date}\n\n{entry}"),
        Some(text) if text.is_empty() || text.ends_with('\n') => format!("{text}{entry}"),
        Some(text) => format!("{text}\n{entry}"),
    }
}

pub fn capture_text(value: &str) -> bool {
    !value.trim().is_empty() && !value.chars().any(char::is_control)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Editor {
    lines: Vec<String>,
    row: usize,
    column: usize,
    pub scroll: usize,
}

impl Default for Editor {
    fn default() -> Self {
        Self::new("")
    }
}

impl Editor {
    pub fn new(text: &str) -> Self {
        let lines = text
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line).to_owned())
            .collect();
        Self {
            lines,
            row: 0,
            column: 0,
            scroll: 0,
        }
    }

    pub fn text(&self) -> String {
        self.lines.join("\n")
    }

    pub fn lines(&self) -> &[String] {
        &self.lines
    }

    pub fn cursor(&self) -> (usize, usize) {
        (self.row, self.column)
    }

    pub fn bytes(&self) -> usize {
        self.lines.iter().map(String::len).sum::<usize>() + self.lines.len().saturating_sub(1)
    }

    fn line(&self) -> &str {
        &self.lines[self.row]
    }

    fn chars(&self) -> usize {
        self.line().chars().count()
    }

    fn offset(&self, column: usize) -> usize {
        self.line()
            .char_indices()
            .nth(column)
            .map_or(self.line().len(), |(index, _)| index)
    }

    pub fn insert(&mut self, text: &str) -> bool {
        let text = text
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .replace('\t', TAB);
        let text: String = text
            .chars()
            .filter(|c| *c == '\n' || !c.is_control())
            .collect();
        if text.is_empty() {
            return true;
        }
        if self.bytes() + text.len() > NOTE_BYTES {
            return false;
        }
        let at = self.offset(self.column);
        let tail = self.lines[self.row].split_off(at);
        let mut parts = text.split('\n');
        if let Some(first) = parts.next() {
            self.lines[self.row].push_str(first);
        }
        for part in parts {
            self.row += 1;
            self.lines.insert(self.row, part.to_owned());
        }
        self.column = self.chars();
        self.lines[self.row].push_str(&tail);
        true
    }

    pub fn backspace(&mut self) {
        if self.column > 0 {
            let end = self.offset(self.column);
            let start = self.offset(self.column - 1);
            self.lines[self.row].replace_range(start..end, "");
            self.column -= 1;
        } else if self.row > 0 {
            let line = self.lines.remove(self.row);
            self.row -= 1;
            self.column = self.chars();
            self.lines[self.row].push_str(&line);
        }
    }

    pub fn delete(&mut self) {
        if self.column < self.chars() {
            let start = self.offset(self.column);
            let end = self.offset(self.column + 1);
            self.lines[self.row].replace_range(start..end, "");
        } else if self.row + 1 < self.lines.len() {
            let line = self.lines.remove(self.row + 1);
            self.lines[self.row].push_str(&line);
        }
    }

    pub fn left(&mut self) {
        if self.column > 0 {
            self.column -= 1;
        } else if self.row > 0 {
            self.row -= 1;
            self.column = self.chars();
        }
    }

    pub fn right(&mut self) {
        if self.column < self.chars() {
            self.column += 1;
        } else if self.row + 1 < self.lines.len() {
            self.row += 1;
            self.column = 0;
        }
    }

    pub fn vertical(&mut self, delta: isize) {
        let last = self.lines.len().saturating_sub(1);
        self.row = self.row.saturating_add_signed(delta).min(last);
        self.column = self.column.min(self.chars());
    }

    pub fn home(&mut self) {
        self.column = 0;
    }

    pub fn end(&mut self) {
        self.column = self.chars();
    }

    pub fn follow(&mut self, height: usize) {
        self.scroll = visible_start(self.scroll, self.row, height);
    }
}

pub fn visible_start(scroll: usize, row: usize, height: usize) -> usize {
    let height = height.max(1);
    if row < scroll {
        row
    } else if row >= scroll + height {
        row + 1 - height
    } else {
        scroll
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_editor_inserts_splits_joins_and_moves_across_lines() {
        let mut editor = Editor::new("ab\r\ncd");
        assert_eq!(editor.lines(), ["ab", "cd"]);
        editor.right();
        assert!(editor.insert("X\nY"));
        assert_eq!(editor.text(), "aX\nYb\ncd");
        assert_eq!(editor.cursor(), (1, 1));
        editor.home();
        editor.backspace();
        assert_eq!(editor.text(), "aXYb\ncd");
        assert_eq!(editor.cursor(), (0, 2));
        editor.end();
        editor.delete();
        assert_eq!(editor.text(), "aXYbcd");
        editor.vertical(5);
        assert_eq!(editor.cursor(), (0, 4));
        editor.end();
        assert!(editor.insert("\tž"));
        assert_eq!(editor.text(), "aXYbcd    ž");
        editor.backspace();
        editor.left();
        editor.left();
        editor.delete();
        assert_eq!(editor.text(), "aXYbcd   ");
        editor.home();
        editor.left();
        assert_eq!(editor.cursor(), (0, 0));
        assert!(editor.insert("\u{7}"));
        assert_eq!(editor.text(), "aXYbcd   ");
    }

    #[test]
    fn notes_editor_refuses_text_over_the_host_cap_and_follows_the_cursor() {
        let mut editor = Editor::new(&"a".repeat(NOTE_BYTES - 1));
        assert!(editor.insert("b"));
        assert!(!editor.insert("c"));
        assert_eq!(editor.bytes(), NOTE_BYTES);
        let mut editor = Editor::new(&"line\n".repeat(30));
        editor.vertical(20);
        editor.follow(10);
        assert_eq!(editor.scroll, 11);
        editor.vertical(-15);
        editor.follow(10);
        assert_eq!(editor.scroll, 5);
        assert_eq!(visible_start(3, 4, 0), 4);
    }

    #[test]
    fn notes_names_slug_unique_join_and_capture_lines() {
        assert_eq!(slug("\n## Release Plan: v2!\nbody"), "release-plan-v2");
        assert_eq!(slug("   "), "note");
        assert_eq!(slug("Zażółć gęślą"), "zażółć-gęślą");
        let taken = vec!["plan.md".to_owned(), "Plan-2.md".to_owned()];
        assert_eq!(unique_name("# Plan", &taken), "plan-3.md");
        assert!(valid_name(&unique_name(&"x".repeat(300), &[])));
        assert_eq!(
            join("C:\\w\\.nesvo\\notes\\", "a.md"),
            "C:\\w\\.nesvo\\notes\\a.md"
        );
        assert_eq!(join("/w/.nesvo/notes", "a.md"), "/w/.nesvo/notes/a.md");
        assert_eq!(today_name("2026-10-21"), "2026-10-21.md");
        assert_eq!(
            captured(None, "2026-10-21", "09:05", " idea "),
            "# 2026-10-21\n\n- 09:05 idea\n"
        );
        assert_eq!(
            captured(Some("# x\n- a"), "2026-10-21", "09:06", "b"),
            "# x\n- a\n- 09:06 b\n"
        );
        assert!(!capture_text("  "));
        assert!(!capture_text("a\u{1b}b"));
    }

    #[test]
    fn notes_last_open_entries_are_bounded_and_sanitized() {
        let mut last = Vec::new();
        for index in 0..40 {
            remember(&mut last, &format!("/p{index}"), "a.md");
        }
        remember(&mut last, "/p39", "b.md");
        remember(&mut last, "/p1", "../x");
        assert_eq!(last.len(), MAX_PROJECTS);
        assert_eq!(last[0].name, "b.md");
        let saved: Saved = serde_json::from_value(serde_json::json!({"last":[
            {"directory":"/a","name":"a.md"},{"directory":"/a","name":"b.md"},
            {"directory":"","name":"c.md"},{"directory":"/d","name":"evil"}
        ]}))
        .unwrap();
        assert_eq!(
            saved.sanitized(),
            [LastNote {
                directory: "/a".into(),
                name: "a.md".into()
            }]
        );
        let broken: Saved = serde_json::from_value(serde_json::json!({"last":7})).unwrap();
        assert!(broken.last.is_empty());
    }

    #[test]
    fn notes_search_matches_names_first_lines_and_loaded_content() {
        let summary = Summary {
            name: "plan.md".into(),
            first_line: "# Release".into(),
            ..Default::default()
        };
        assert!(matches("", &summary, None));
        assert!(matches("PLAN rel", &summary, None));
        assert!(!matches("deploy", &summary, None));
        assert!(matches("deploy", &summary, Some("then deploy")));
        assert_eq!(summary.title(), "plan");
        assert_eq!(summary.heading(), "Release");
    }
}
