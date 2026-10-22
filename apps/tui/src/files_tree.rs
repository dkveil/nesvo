pub use nesvo_wire::views::files::{FileEntry as Entry, FileKind as Kind};
use std::collections::HashMap;

pub const MAX_EXPANDED: usize = 256;
pub const MAX_PATH_BYTES: usize = 512;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Listing {
    pub entries: Vec<Entry>,
    pub truncated: bool,
}

#[derive(Debug, Default)]
struct Slot {
    listing: Option<Listing>,
    pending: Option<String>,
    error: Option<String>,
    stale: bool,
}

impl Slot {
    fn wanted(&self) -> bool {
        self.pending.is_none()
            && ((self.listing.is_none() && self.error.is_none())
                || (self.stale && self.listing.is_some()))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RowKind<'a> {
    Entry(&'a Entry),
    Loading,
    Failed(&'a str),
    Truncated,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Row<'a> {
    pub path: String,
    pub depth: usize,
    pub kind: RowKind<'a>,
    pub expanded: bool,
}

impl Row<'_> {
    pub fn entry(&self) -> Option<&Entry> {
        match self.kind {
            RowKind::Entry(entry) => Some(entry),
            _ => None,
        }
    }

    pub fn is_dir(&self) -> bool {
        self.entry().is_some_and(|entry| entry.kind == Kind::Dir)
    }
}

pub fn child(directory: &str, name: &str) -> String {
    if directory.is_empty() {
        name.to_owned()
    } else {
        format!("{directory}/{name}")
    }
}

pub fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

fn within(path: &str, directory: &str) -> bool {
    path.strip_prefix(directory)
        .is_some_and(|rest| rest.starts_with('/'))
}

pub fn valid_relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= MAX_PATH_BYTES
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\'])
        && !name.chars().any(char::is_control)
}

pub fn separator(root: &str) -> char {
    if root.contains('\\') { '\\' } else { '/' }
}

pub fn absolute(root: &str, relative: &str) -> String {
    if relative.is_empty() {
        return root.to_owned();
    }
    let separator = separator(root);
    let base = root.trim_end_matches(['/', '\\']);
    format!(
        "{base}{separator}{}",
        relative.replace('/', &separator.to_string())
    )
}

pub fn base_name(root: &str) -> &str {
    let trimmed = root.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(root)
}

#[derive(Debug)]
pub struct Tree {
    root: String,
    expanded: Vec<String>,
    slots: HashMap<String, Slot>,
    selected: usize,
    selected_path: Option<String>,
    show_hidden: bool,
}

impl Tree {
    pub fn new(root: String, expanded: Vec<String>, show_hidden: bool) -> Self {
        let mut tree = Self {
            root,
            expanded: Vec::new(),
            slots: HashMap::new(),
            selected: 0,
            selected_path: None,
            show_hidden,
        };
        for path in expanded.into_iter().filter(|path| valid_relative(path)) {
            tree.insert_expanded(path);
        }
        tree
    }

    pub fn root(&self) -> &str {
        &self.root
    }

    pub fn expanded(&self) -> &[String] {
        &self.expanded
    }

    pub fn show_hidden(&self) -> bool {
        self.show_hidden
    }

    pub fn is_expanded(&self, path: &str) -> bool {
        self.expanded.iter().any(|known| known == path)
    }

    fn insert_expanded(&mut self, path: String) {
        if path.is_empty() || path.len() > MAX_PATH_BYTES || self.is_expanded(&path) {
            return;
        }
        if self.expanded.len() >= MAX_EXPANDED {
            self.expanded.remove(0);
        }
        self.expanded.push(path);
    }

    pub fn rows(&self) -> Vec<Row<'_>> {
        let mut rows = Vec::new();
        self.push_rows("", 0, &mut rows);
        rows
    }

    fn push_rows<'a>(&'a self, directory: &str, depth: usize, rows: &mut Vec<Row<'a>>) {
        let slot = self.slots.get(directory);
        let Some(listing) = slot.and_then(|slot| slot.listing.as_ref()) else {
            rows.push(Row {
                path: child(directory, "\u{0}status"),
                depth,
                kind: match slot.and_then(|slot| slot.error.as_deref()) {
                    Some(error) => RowKind::Failed(error),
                    None => RowKind::Loading,
                },
                expanded: false,
            });
            return;
        };
        if let Some(error) = slot.and_then(|slot| slot.error.as_deref()) {
            rows.push(Row {
                path: child(directory, "\u{0}status"),
                depth,
                kind: RowKind::Failed(error),
                expanded: false,
            });
        }
        for entry in &listing.entries {
            let path = child(directory, &entry.name);
            let expanded = entry.kind == Kind::Dir && self.is_expanded(&path);
            rows.push(Row {
                path: path.clone(),
                depth,
                kind: RowKind::Entry(entry),
                expanded,
            });
            if expanded {
                self.push_rows(&path, depth + 1, rows);
            }
        }
        if listing.truncated {
            rows.push(Row {
                path: child(directory, "\u{0}more"),
                depth,
                kind: RowKind::Truncated,
                expanded: false,
            });
        }
    }

    pub fn selected_index(&self, rows: &[Row]) -> usize {
        self.selected_path
            .as_ref()
            .and_then(|path| rows.iter().position(|row| &row.path == path))
            .unwrap_or(self.selected)
            .min(rows.len().saturating_sub(1))
    }

    pub fn selected_path(&self) -> Option<String> {
        let rows = self.rows();
        rows.get(self.selected_index(&rows))
            .filter(|row| row.entry().is_some())
            .map(|row| row.path.clone())
    }

    pub fn selected_entry(&self) -> Option<(String, Entry)> {
        let rows = self.rows();
        let row = rows.get(self.selected_index(&rows))?;
        row.entry().map(|entry| (row.path.clone(), entry.clone()))
    }

    pub fn select_path(&mut self, path: &str) {
        self.selected_path = Some(path.to_owned());
    }

    pub fn move_by(&mut self, delta: isize) {
        let (rows, index) = self.snapshot();
        if rows.is_empty() {
            return;
        }
        let next = index
            .saturating_add_signed(delta)
            .min(rows.len().saturating_sub(1));
        self.select_owned(&rows, next);
    }

    fn snapshot(&self) -> (Vec<String>, usize) {
        let rows = self.rows();
        let index = self.selected_index(&rows);
        (rows.into_iter().map(|row| row.path).collect(), index)
    }

    fn select_owned(&mut self, paths: &[String], index: usize) {
        if let Some(path) = paths.get(index) {
            self.selected = index;
            self.selected_path = Some(path.clone());
        }
    }

    pub fn expand(&mut self) {
        let rows = self.rows();
        let index = self.selected_index(&rows);
        let Some(row) = rows.get(index) else {
            return;
        };
        if !row.is_dir() {
            return;
        }
        if row.expanded {
            let next = rows
                .get(index + 1)
                .filter(|next| next.depth > row.depth)
                .map(|_| index + 1);
            let paths: Vec<String> = rows.iter().map(|row| row.path.clone()).collect();
            if let Some(next) = next {
                self.select_owned(&paths, next);
            }
            return;
        }
        let path = row.path.clone();
        self.selected = index;
        self.selected_path = Some(path.clone());
        self.insert_expanded(path);
    }

    pub fn collapse(&mut self) {
        let rows = self.rows();
        let index = self.selected_index(&rows);
        let Some(row) = rows.get(index) else {
            return;
        };
        let expanded = row.expanded;
        let path = row.path.clone();
        let paths: Vec<String> = rows.into_iter().map(|row| row.path).collect();
        if expanded {
            self.expanded.retain(|known| known != &path);
            return;
        }
        let parent = parent(&path);
        if let Some(position) = paths.iter().position(|known| known == parent) {
            self.select_owned(&paths, position);
        }
    }

    pub fn toggle(&mut self) {
        let rows = self.rows();
        let index = self.selected_index(&rows);
        if rows.get(index).is_some_and(|row| row.expanded) {
            self.collapse();
        } else {
            self.expand();
        }
    }

    pub fn reveal(&mut self, path: &str) {
        let mut ancestor = parent(path);
        let mut chain = Vec::new();
        while !ancestor.is_empty() {
            chain.push(ancestor.to_owned());
            ancestor = parent(ancestor);
        }
        for directory in chain.into_iter().rev() {
            self.insert_expanded(directory);
        }
        self.select_path(path);
    }

    pub fn wanted(&self) -> Vec<String> {
        let mut wanted = Vec::new();
        if self.slots.get("").is_none_or(Slot::wanted) {
            wanted.push(String::new());
        }
        for path in &self.expanded {
            if self.visible_folder(path) && self.slots.get(path).is_none_or(Slot::wanted) {
                wanted.push(path.clone());
            }
        }
        wanted
    }

    fn visible_folder(&self, path: &str) -> bool {
        let parent = parent(path);
        let name = path.rsplit('/').next().unwrap_or(path);
        (parent.is_empty() || (self.is_expanded(parent) && self.visible_folder(parent)))
            && self
                .slots
                .get(parent)
                .and_then(|slot| slot.listing.as_ref())
                .is_some_and(|listing| {
                    listing
                        .entries
                        .iter()
                        .any(|entry| entry.kind == Kind::Dir && entry.name == name)
                })
    }

    pub fn pending_count(&self) -> usize {
        self.slots
            .values()
            .filter(|slot| slot.pending.is_some())
            .count()
    }

    pub fn mark_pending(&mut self, directory: &str, request_id: String) {
        self.slots.entry(directory.to_owned()).or_default().pending = Some(request_id);
    }

    fn pending_slot(&mut self, request_id: &str) -> Option<(String, &mut Slot)> {
        self.slots
            .iter_mut()
            .find(|(_, slot)| slot.pending.as_deref() == Some(request_id))
            .map(|(directory, slot)| (directory.clone(), slot))
    }

    pub fn owns_request(&self, request_id: &str) -> bool {
        self.slots
            .values()
            .any(|slot| slot.pending.as_deref() == Some(request_id))
    }

    pub fn accept(&mut self, request_id: &str, mut listing: Listing) -> bool {
        let Some((directory, slot)) = self.pending_slot(request_id) else {
            return false;
        };
        listing.entries.retain(|entry| valid_name(&entry.name));
        slot.pending = None;
        slot.error = None;
        slot.stale = false;
        let complete = !listing.truncated;
        let folders: Vec<String> = listing
            .entries
            .iter()
            .filter(|entry| entry.kind == Kind::Dir)
            .map(|entry| child(&directory, &entry.name))
            .collect();
        slot.listing = Some(listing);
        if complete {
            let gone: Vec<String> = self
                .expanded
                .iter()
                .filter(|path| parent(path) == directory && !folders.contains(path))
                .cloned()
                .collect();
            for path in gone {
                self.expanded
                    .retain(|known| known != &path && !within(known, &path));
                self.slots
                    .retain(|known, _| known != &path && !within(known, &path));
            }
        }
        true
    }

    pub fn fail(&mut self, request_id: &str, message: Option<String>) -> bool {
        let Some((_, slot)) = self.pending_slot(request_id) else {
            return false;
        };
        slot.pending = None;
        match message {
            Some(message) => {
                slot.error = Some(message);
                slot.stale = false;
            }
            None => slot.stale = slot.listing.is_some(),
        }
        true
    }

    pub fn refresh(&mut self) {
        for slot in self.slots.values_mut() {
            slot.error = None;
            slot.stale = true;
        }
    }

    pub fn set_hidden(&mut self, show_hidden: bool) {
        self.show_hidden = show_hidden;
        self.slots.clear();
    }

    pub fn pending_ids(&self) -> Vec<String> {
        self.slots
            .values()
            .filter_map(|slot| slot.pending.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, kind: Kind, status: Option<&str>, ignored: bool) -> Entry {
        Entry {
            name: name.into(),
            kind,
            size: 1,
            status: status.map(str::to_owned),
            ignored,
        }
    }

    fn listing(entries: Vec<Entry>) -> Listing {
        Listing {
            entries,
            truncated: false,
        }
    }

    fn loaded() -> Tree {
        let mut tree = Tree::new("/work".into(), Vec::new(), false);
        assert_eq!(tree.wanted(), [""]);
        tree.mark_pending("", "r1".into());
        assert!(tree.accept(
            "r1",
            listing(vec![
                entry("src", Kind::Dir, Some("M"), false),
                entry("target", Kind::Dir, Some("!"), true),
                entry("README.md", Kind::File, None, false),
            ])
        ));
        tree
    }

    fn paths(tree: &Tree) -> Vec<String> {
        tree.rows().into_iter().map(|row| row.path).collect()
    }

    #[test]
    fn files_tree_expand_requests_once_and_collapse_returns_to_the_parent() {
        let mut tree = loaded();
        assert!(tree.wanted().is_empty());
        assert_eq!(paths(&tree), ["src", "target", "README.md"]);
        tree.expand();
        assert!(tree.is_expanded("src"));
        assert_eq!(tree.wanted(), ["src"]);
        assert!(matches!(tree.rows()[1].kind, RowKind::Loading));
        tree.mark_pending("src", "r2".into());
        assert!(tree.wanted().is_empty());
        assert!(!tree.accept("unknown", Listing::default()));
        tree.accept(
            "r2",
            listing(vec![entry("main.rs", Kind::File, Some("M"), false)]),
        );
        assert_eq!(paths(&tree), ["src", "src/main.rs", "target", "README.md"]);
        tree.expand();
        assert_eq!(tree.selected_path().as_deref(), Some("src/main.rs"));
        tree.collapse();
        assert_eq!(tree.selected_path().as_deref(), Some("src"));
        tree.collapse();
        assert!(!tree.is_expanded("src"));
        assert_eq!(paths(&tree), ["src", "target", "README.md"]);
        tree.toggle();
        assert_eq!(paths(&tree), ["src", "src/main.rs", "target", "README.md"]);
        assert!(tree.wanted().is_empty());
    }

    #[test]
    fn files_tree_refresh_keeps_rows_until_the_new_listing_and_prunes_missing_folders() {
        let mut tree = loaded();
        tree.expand();
        tree.mark_pending("src", "r2".into());
        tree.accept("r2", listing(vec![entry("lib", Kind::Dir, None, false)]));
        tree.move_by(1);
        tree.expand();
        assert!(tree.is_expanded("src/lib"));
        tree.refresh();
        assert_eq!(tree.wanted(), ["", "src", "src/lib"]);
        assert_eq!(paths(&tree)[..2], ["src".to_owned(), "src/lib".to_owned()]);
        tree.mark_pending("", "r3".into());
        tree.accept(
            "r3",
            listing(vec![entry("README.md", Kind::File, None, false)]),
        );
        assert!(!tree.is_expanded("src"));
        assert!(!tree.is_expanded("src/lib"));
        assert_eq!(paths(&tree), ["README.md"]);
        assert_eq!(tree.selected_index(&tree.rows()), 0);
    }

    #[test]
    fn files_tree_truncated_listing_keeps_expanded_folders_and_shows_a_more_row() {
        let mut tree = Tree::new("/work".into(), vec!["deep".into()], false);
        tree.mark_pending("", "r1".into());
        tree.accept(
            "r1",
            Listing {
                entries: vec![entry("a", Kind::File, None, false)],
                truncated: true,
            },
        );
        assert!(tree.is_expanded("deep"));
        assert!(matches!(
            tree.rows().last().unwrap().kind,
            RowKind::Truncated
        ));
    }

    #[test]
    fn files_tree_hidden_toggle_drops_cached_listings_and_ignores_late_replies() {
        let mut tree = loaded();
        tree.expand();
        tree.mark_pending("src", "late".into());
        tree.set_hidden(true);
        assert!(tree.show_hidden());
        assert!(tree.is_expanded("src"));
        assert!(!tree.accept("late", Listing::default()));
        assert_eq!(tree.wanted(), [""]);
        tree.mark_pending("", "r4".into());
        tree.accept(
            "r4",
            listing(vec![
                entry(".git", Kind::Dir, None, false),
                entry("src", Kind::Dir, None, false),
            ]),
        );
        assert_eq!(tree.wanted(), ["src"]);
        assert_eq!(tree.selected_path().as_deref(), Some("src"));
    }

    #[test]
    fn files_tree_ignored_entries_keep_their_flag_and_letter() {
        let tree = loaded();
        let rows = tree.rows();
        let target = rows[1].entry().unwrap();
        assert!(target.ignored);
        assert_eq!(target.status.as_deref(), Some("!"));
        assert_eq!(rows[0].entry().unwrap().status.as_deref(), Some("M"));
        assert!(!rows[2].entry().unwrap().ignored);
    }

    #[test]
    fn files_tree_failures_show_a_row_and_retry_only_after_refresh() {
        let mut tree = loaded();
        tree.expand();
        tree.mark_pending("src", "r2".into());
        assert!(tree.fail("r2", Some("This folder does not exist".into())));
        assert!(matches!(
            tree.rows()[1].kind,
            RowKind::Failed("This folder does not exist")
        ));
        assert!(tree.wanted().is_empty());
        tree.refresh();
        assert_eq!(tree.wanted(), ["", "src"]);
        tree.mark_pending("", "busy".into());
        assert!(tree.fail("busy", None));
        assert_eq!(tree.wanted(), ["", "src"]);
    }

    #[test]
    fn files_tree_expanded_set_is_capped_validated_and_revealed_paths_expand_ancestors() {
        let many: Vec<String> = (0..MAX_EXPANDED + 10).map(|n| format!("d{n}")).collect();
        let mut tree = Tree::new(
            "/work".into(),
            many.into_iter()
                .chain([
                    "../up".into(),
                    "a//b".into(),
                    "./x".into(),
                    "a\u{1}b".into(),
                ])
                .collect(),
            false,
        );
        assert_eq!(tree.expanded().len(), MAX_EXPANDED);
        assert_eq!(tree.expanded()[0], "d10");
        tree.reveal("src/deep/file.rs");
        assert!(tree.is_expanded("src"));
        assert!(tree.is_expanded("src/deep"));
        assert_eq!(tree.expanded().len(), MAX_EXPANDED);
    }

    #[test]
    fn files_tree_skips_entry_names_that_could_inject_input_or_escape_the_root() {
        let mut tree = Tree::new("/work".into(), Vec::new(), false);
        tree.mark_pending("", "r1".into());
        tree.accept(
            "r1",
            listing(
                [
                    "ok.rs",
                    "red\u{1b}[31m",
                    "line\nbreak",
                    "",
                    ".",
                    "..",
                    "a/b",
                    r"a\b",
                    ".env",
                ]
                .into_iter()
                .map(|name| entry(name, Kind::File, None, false))
                .collect(),
            ),
        );
        assert_eq!(paths(&tree), ["ok.rs", ".env"]);
        assert!(valid_name("..."));
        assert!(!valid_name("tab\there"));
    }

    #[test]
    fn files_tree_paths_join_with_the_root_separator() {
        assert_eq!(
            absolute("C:\\work\\", "src/main.rs"),
            "C:\\work\\src\\main.rs"
        );
        assert_eq!(absolute("/work", "src/main.rs"), "/work/src/main.rs");
        assert_eq!(absolute("/", "etc"), "/etc");
        assert_eq!(absolute("C:/work", ""), "C:/work");
        assert_eq!(base_name("C:\\work\\nesvo\\"), "nesvo");
        assert_eq!(base_name("/"), "/");
    }
}
