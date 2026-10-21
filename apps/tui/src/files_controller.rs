use crate::{
    files_tree::{self, Entry, Kind, Listing, Tree},
    layouts::Role,
    model::{App, Dialog, Mode},
    palette::{ResultRow, Target},
};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;
use serde::{Deserialize, Deserializer, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::collections::HashSet;

pub const MAX_IN_FLIGHT: usize = 2;
pub const MAX_ROOTS: usize = 32;
pub const SAVED_BYTES: usize = 12 * 1024;
pub const PREVIEW_BYTES: usize = 1024 * 1024;
const MAX_ROOT_BYTES: usize = 1024;
const FIND_LIMIT: usize = 50;
const BUSY_RETRIES: u8 = 3;
const TREE_PAGE: isize = 10;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SidebarMode {
    #[default]
    Sessions,
    Files,
}

impl SidebarMode {
    pub fn key(self) -> &'static str {
        match self {
            Self::Sessions => crate::layouts::SIDEBAR_SESSIONS,
            Self::Files => "files",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Sessions => "Sessions",
            Self::Files => "Files",
        }
    }

    fn from_key(key: &str) -> Option<Self> {
        [Self::Sessions, Self::Files]
            .into_iter()
            .find(|mode| mode.key() == key)
    }
}

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
pub struct SavedRoot {
    #[serde(deserialize_with = "lenient")]
    pub root: String,
    #[serde(deserialize_with = "lenient")]
    pub expanded: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Saved {
    #[serde(deserialize_with = "lenient")]
    pub sidebar_mode: SidebarMode,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub pinned: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub show_hidden: bool,
    #[serde(deserialize_with = "lenient")]
    pub roots: Vec<SavedRoot>,
}

fn valid_root(root: &str) -> bool {
    !root.is_empty() && root.len() <= MAX_ROOT_BYTES && !root.chars().any(char::is_control)
}

fn sanitized(root: &SavedRoot) -> Option<SavedRoot> {
    valid_root(&root.root).then(|| SavedRoot {
        root: root.root.clone(),
        expanded: root
            .expanded
            .iter()
            .filter(|path| files_tree::valid_relative(path))
            .take(files_tree::MAX_EXPANDED)
            .cloned()
            .collect(),
    })
}

#[derive(Debug, Default)]
pub struct Preview {
    pub path: String,
    pub relative: String,
    pub text: String,
    pub size: u64,
    pub next: u64,
    pub truncated: bool,
    pub scroll: usize,
    pub error: Option<String>,
    want: Option<u64>,
    pending: Option<(String, u64)>,
}

impl Preview {
    fn new(path: String, relative: String) -> Self {
        Self {
            path,
            relative,
            want: Some(0),
            ..Default::default()
        }
    }

    pub fn loading(&self) -> bool {
        self.want.is_some() || self.pending.is_some()
    }

    pub fn line_count(&self) -> usize {
        self.text.lines().count()
    }

    pub fn limit_reached(&self) -> bool {
        self.text.len() >= PREVIEW_BYTES
    }

    fn more_available(&self) -> bool {
        self.truncated && !self.limit_reached() && self.error.is_none()
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Match {
    pub path: String,
    #[serde(default)]
    pub score: i64,
}

#[derive(Debug, Default)]
pub struct Find {
    pub root: String,
    pub query: String,
    pub matches: Vec<Match>,
    pub truncated: bool,
    pub error: Option<String>,
    requested: bool,
    pending: Option<(String, String, String)>,
}

#[derive(Debug, Default)]
pub struct FilesState {
    pub mode: SidebarMode,
    pub pinned: Option<String>,
    pub show_hidden: bool,
    pub tree: Option<Tree>,
    pub preview: Option<Preview>,
    pub find: Find,
    remembered: Vec<SavedRoot>,
    orphans: HashSet<String>,
    busy: u8,
}

impl FilesState {
    pub fn capture(&self) -> Saved {
        let current = self.tree.as_ref().map(|tree| SavedRoot {
            root: tree.root().to_owned(),
            expanded: tree.expanded().to_vec(),
        });
        let mut roots = Vec::new();
        let mut used = 0;
        for root in current.iter().chain(
            self.remembered
                .iter()
                .filter(|root| current.as_ref().is_none_or(|known| known.root != root.root)),
        ) {
            if root.expanded.is_empty() || roots.len() >= MAX_ROOTS {
                continue;
            }
            let bytes = serde_json::to_vec(root).map_or(usize::MAX, |bytes| bytes.len());
            if used + bytes > SAVED_BYTES {
                break;
            }
            used += bytes;
            roots.push(root.clone());
        }
        Saved {
            sidebar_mode: self.mode,
            pinned: self.pinned.clone(),
            show_hidden: self.show_hidden,
            roots,
        }
    }

    pub fn restore(&mut self, saved: &Saved) {
        self.mode = saved.sidebar_mode;
        self.pinned = saved.pinned.clone().filter(|root| valid_root(root));
        self.show_hidden = saved.show_hidden;
        self.remembered = saved
            .roots
            .iter()
            .filter_map(sanitized)
            .take(MAX_ROOTS)
            .collect();
        self.drop_tree();
    }

    fn drop_tree(&mut self) {
        if let Some(tree) = self.tree.take() {
            self.orphans.extend(tree.pending_ids());
            self.remembered.retain(|root| root.root != tree.root());
            self.remembered.insert(
                0,
                SavedRoot {
                    root: tree.root().to_owned(),
                    expanded: tree.expanded().to_vec(),
                },
            );
            self.remembered.truncate(MAX_ROOTS);
        }
    }

    fn in_flight(&self) -> usize {
        self.tree.as_ref().map_or(0, Tree::pending_count)
            + usize::from(
                self.preview
                    .as_ref()
                    .is_some_and(|preview| preview.pending.is_some()),
            )
            + usize::from(self.find.pending.is_some())
            + self.orphans.len()
    }
}

pub fn supported(app: &App) -> bool {
    app.host_features["files"] == true
}

fn review_directory(app: &App) -> Option<String> {
    app.reviews
        .active()
        .and_then(|tab| tab.opened.as_ref())
        .map(|opened| opened.directory.clone())
        .or_else(|| {
            app.review
                .visible
                .then(|| app.review.data.directory.clone())
                .flatten()
        })
        .filter(|directory| valid_root(directory))
}

pub fn root(app: &App) -> Option<String> {
    app.files
        .pinned
        .clone()
        .or_else(|| review_directory(app))
        .or_else(|| app.review_candidate().map(|session| session.cwd.clone()))
        .filter(|root| valid_root(root))
}

pub fn files_leaf(app: &App) -> bool {
    app.pane_tree().position(Role::Files).is_some()
}

pub fn shows_tree(app: &App) -> bool {
    app.files.mode == SidebarMode::Files || files_leaf(app)
}

pub fn sidebar_shows_files(app: &App) -> bool {
    app.files.mode == SidebarMode::Files && !files_leaf(app)
}

pub fn keys_active(app: &App) -> bool {
    app.files.mode == SidebarMode::Files && app.mode == Mode::Navigate && app.dialog.is_none()
}

pub fn preview_docked(app: &App) -> bool {
    app.files.preview.is_some()
        && app.files.mode == SidebarMode::Files
        && app.mode == Mode::Navigate
}

pub fn files_query(query: &str) -> Option<&str> {
    query.trim_start().strip_prefix('#').map(str::trim)
}

fn palette_query(app: &App) -> Option<String> {
    match &app.dialog {
        Some(Dialog::QuickSwitch { query, .. }) => files_query(query).map(str::to_owned),
        _ => None,
    }
}

fn ensure_root(app: &mut App, root: String) {
    if app
        .files
        .tree
        .as_ref()
        .is_some_and(|tree| tree.root() == root)
    {
        return;
    }
    app.files.drop_tree();
    let expanded = app
        .files
        .remembered
        .iter()
        .find(|known| known.root == root)
        .map(|known| known.expanded.clone())
        .unwrap_or_default();
    app.files.tree = Some(Tree::new(root, expanded, app.files.show_hidden));
}

pub fn sync(app: &mut App) -> Vec<Value> {
    let mut commands = Vec::new();
    if !app.connected
        || !supported(app)
        || !(shows_tree(app) || app.files.preview.is_some() || palette_query(app).is_some())
    {
        return commands;
    }
    let root = root(app);
    if shows_tree(app)
        && let Some(root) = root.clone()
    {
        ensure_root(app, root);
    }
    if app.files.in_flight() < MAX_IN_FLIGHT
        && let Some(preview) = &app.files.preview
        && preview.pending.is_none()
        && let Some(offset) = preview.want
    {
        let path = preview.path.clone();
        let command = app.request(json!({"type":"readFile","path":path,"offset":offset}));
        if let Some(preview) = &mut app.files.preview {
            preview.want = None;
            preview.pending = command["requestId"]
                .as_str()
                .map(|id| (id.to_owned(), offset));
        }
        commands.push(command);
    }
    if app.files.in_flight() < MAX_IN_FLIGHT
        && app.files.find.pending.is_none()
        && let Some(query) = palette_query(app)
        && let Some(root) = root.clone()
        && (!app.files.find.requested
            || app.files.find.root != root
            || app.files.find.query != query)
    {
        let command =
            app.request(json!({"type":"findFiles","root":root,"query":query,"limit":FIND_LIMIT}));
        if let Some(id) = command["requestId"].as_str() {
            app.files.find.pending = Some((id.to_owned(), root, query));
        }
        commands.push(command);
    }
    if shows_tree(app)
        && app.files.in_flight() < MAX_IN_FLIGHT
        && let Some(tree) = &app.files.tree
    {
        let root = tree.root().to_owned();
        let show_hidden = tree.show_hidden();
        let wanted = tree.wanted();
        for directory in wanted {
            if app.files.in_flight() >= MAX_IN_FLIGHT {
                break;
            }
            let command = app.request(json!({"type":"listEntries",
                "directory":files_tree::absolute(&root, &directory),"showHidden":show_hidden}));
            if let (Some(tree), Some(id)) = (&mut app.files.tree, command["requestId"].as_str()) {
                tree.mark_pending(&directory, id.to_owned());
            }
            commands.push(command);
        }
    }
    commands
}

pub fn host_event(app: &mut App, event: &Value) {
    let Some(id) = event["requestId"].as_str() else {
        return;
    };
    if app.files.orphans.remove(id) {
        return;
    }
    match event["type"].as_str() {
        Some("entries") => {
            let Some(tree) = app.files.tree.as_mut().filter(|tree| tree.owns_request(id)) else {
                return;
            };
            app.files.busy = 0;
            match serde_json::from_value::<Vec<Entry>>(event["entries"].clone()) {
                Ok(entries) => {
                    tree.accept(
                        id,
                        Listing {
                            entries,
                            truncated: event["truncated"] == true,
                        },
                    );
                }
                Err(_) => {
                    tree.fail(id, Some("The host sent an unreadable listing.".into()));
                }
            }
        }
        Some("file") => {
            let Some(preview) = app.files.preview.as_mut().filter(|preview| {
                preview
                    .pending
                    .as_ref()
                    .is_some_and(|(known, _)| known == id)
            }) else {
                return;
            };
            app.files.busy = 0;
            preview.pending = None;
            let offset = event["offset"].as_u64().unwrap_or(0);
            let length = event["length"].as_u64().unwrap_or(0);
            if offset == 0 {
                preview.text.clear();
                preview.scroll = 0;
            }
            let room = PREVIEW_BYTES.saturating_sub(preview.text.len());
            let text = event["text"].as_str().unwrap_or_default();
            let mut cut = text.len().min(room);
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            preview.text.push_str(&text[..cut]);
            preview.size = event["size"].as_u64().unwrap_or(0);
            preview.next = offset + length;
            preview.truncated = event["truncated"] == true && length > 0;
            preview.error = None;
        }
        Some("files") => {
            let find = &mut app.files.find;
            let Some((_, root, query)) = find.pending.take_if(|(known, _, _)| known == id) else {
                return;
            };
            app.files.busy = 0;
            find.requested = true;
            find.root = root;
            find.query = query;
            find.truncated = event["truncated"] == true;
            find.error = None;
            find.matches = serde_json::from_value(event["matches"].clone()).unwrap_or_default();
            if let Some(Dialog::QuickSwitch { selected: None, .. }) = &app.dialog {
                app.select_palette(0);
            }
        }
        _ => {}
    }
}

fn describe(code: &str, message: &str) -> String {
    match code {
        "binary" => "Binary file: the preview shows text only.".into(),
        "outside_root" => "This link points outside the folder or its repository.".into(),
        "busy" => "The host is busy with other file requests. Press r to retry.".into(),
        _ => message.to_owned(),
    }
}

pub fn host_error(app: &mut App, event: &Value) {
    let Some(id) = event["requestId"].as_str() else {
        return;
    };
    if app.files.orphans.remove(id) {
        app.notice.clear();
        return;
    }
    let code = event["code"].as_str().unwrap_or_default();
    let message = describe(
        code,
        event["message"]
            .as_str()
            .unwrap_or("The host rejected the file request."),
    );
    let retry = code == "busy" && app.files.busy < BUSY_RETRIES;
    let failure = (!retry).then(|| message.clone());
    let mut handled = app
        .files
        .tree
        .as_mut()
        .is_some_and(|tree| tree.fail(id, failure.clone()));
    if let Some(preview) = app.files.preview.as_mut()
        && let Some((_, offset)) = preview.pending.take_if(|(known, _)| known == id)
    {
        handled = true;
        if retry {
            preview.want = Some(offset);
        } else {
            preview.error = failure.clone();
        }
    }
    let find = &mut app.files.find;
    if let Some((_, root, query)) = find.pending.take_if(|(known, _, _)| known == id) {
        handled = true;
        if !retry {
            find.requested = true;
            find.root = root;
            find.query = query;
            find.matches.clear();
            find.error = failure;
        }
    }
    if !handled {
        return;
    }
    if code == "busy" {
        app.files.busy = app.files.busy.saturating_add(1);
    }
    if retry {
        app.notice.clear();
    } else {
        app.notice = message;
    }
}

pub fn set_mode(app: &mut App, mode: SidebarMode) {
    app.files.mode = mode;
    if mode == SidebarMode::Files && !supported(app) && app.capabilities.is_some() {
        app.notice = "Update nesvo-host to browse files.".into();
    }
}

pub fn toggle_mode(app: &mut App) {
    set_mode(
        app,
        if app.files.mode == SidebarMode::Files {
            SidebarMode::Sessions
        } else {
            SidebarMode::Files
        },
    );
}

pub fn apply_layout(app: &mut App, sidebar_mode: &str) {
    if let Some(mode) = SidebarMode::from_key(sidebar_mode) {
        app.files.mode = mode;
    }
}

pub fn open_palette(app: &mut App) {
    app.palette_expanded = true;
    app.palette_category = 0;
    app.begin_palette("#".into());
}

pub fn open_found(app: &mut App, path: &str) {
    app.files.mode = SidebarMode::Files;
    let Some(root) = root(app) else {
        return;
    };
    ensure_root(app, root.clone());
    if let Some(tree) = &mut app.files.tree {
        tree.reveal(path);
    }
    open_preview(app, &root, path);
}

fn open_preview(app: &mut App, root: &str, relative: &str) {
    let path = files_tree::absolute(root, relative);
    if let Some(orphan) = app.files.preview.take().and_then(|preview| preview.pending) {
        app.files.orphans.insert(orphan.0);
    }
    app.files.preview = Some(Preview::new(path, relative.to_owned()));
}

fn paste(app: &mut App, absolute: bool, outcome: &mut crate::controller::Outcome) {
    let Some(tree) = &app.files.tree else {
        return;
    };
    let Some(relative) = tree.selected_path() else {
        app.notice = "Select a file or folder to paste its path.".into();
        return;
    };
    let text = if absolute {
        files_tree::absolute(tree.root(), &relative)
    } else {
        relative
    };
    if !pasteable(&text) {
        app.notice = "This path contains control characters; nothing was pasted.".into();
        return;
    }
    let Some(terminal) = app.active_terminal() else {
        app.notice = "Open a session to paste the path into.".into();
        return;
    };
    let data = crate::input::encode_paste(&text, terminal.screen());
    if let Some(command) = app.input(data) {
        outcome.commands.push(command);
        app.notice = format!("Pasted {text}");
    }
}

fn pasteable(text: &str) -> bool {
    !text.is_empty() && !text.chars().any(char::is_control)
}

fn pin(app: &mut App) {
    if app.files.pinned.take().is_some() {
        app.notice = "Files follow the selected session again.".into();
        return;
    }
    let Some(tree) = &app.files.tree else {
        app.notice = "Select a session before pinning a folder.".into();
        return;
    };
    let folder = tree
        .selected_entry()
        .filter(|(_, entry)| entry.kind == Kind::Dir)
        .map_or_else(
            || tree.root().to_owned(),
            |(path, _)| files_tree::absolute(tree.root(), &path),
        );
    app.notice = format!(
        "Pinned {}; press o to unpin.",
        files_tree::base_name(&folder)
    );
    app.files.pinned = Some(folder);
}

fn refresh(app: &mut App) {
    if let Some(tree) = &mut app.files.tree {
        tree.refresh();
    }
    app.files.busy = 0;
    if let Some(preview) = &mut app.files.preview {
        if let Some((id, _)) = preview.pending.take() {
            app.files.orphans.insert(id);
        }
        preview.error = None;
        preview.want = Some(0);
    }
}

fn toggle_hidden(app: &mut App) {
    app.files.show_hidden = !app.files.show_hidden;
    let show = app.files.show_hidden;
    if let Some(tree) = &mut app.files.tree {
        app.files.orphans.extend(tree.pending_ids());
        tree.set_hidden(show);
    }
    app.notice = if show {
        "Showing hidden files.".into()
    } else {
        "Hiding hidden files.".into()
    };
}

fn enter(app: &mut App) {
    let Some(tree) = &mut app.files.tree else {
        return;
    };
    let Some((path, entry)) = tree.selected_entry() else {
        return;
    };
    if entry.kind == Kind::Dir {
        tree.toggle();
        return;
    }
    let root = tree.root().to_owned();
    open_preview(app, &root, &path);
}

fn preview_page(app: &App, area: Rect) -> usize {
    let height = crate::ui::geometry(area, app).files_preview.height;
    usize::from(height.saturating_sub(3)).max(1)
}

fn scroll_preview(app: &mut App, down: bool, area: Rect) {
    let page = preview_page(app, area);
    let Some(preview) = &mut app.files.preview else {
        return;
    };
    let lines = preview.line_count();
    preview.scroll = if down {
        (preview.scroll + page).min(lines.saturating_sub(1))
    } else {
        preview.scroll.saturating_sub(page)
    };
    if down && preview.more_available() && !preview.loading() && preview.scroll + page * 2 >= lines
    {
        preview.want = Some(preview.next);
    }
}

pub fn key(
    app: &mut App,
    key: KeyEvent,
    area: Rect,
    outcome: &mut crate::controller::Outcome,
) -> bool {
    if app.mode != Mode::Navigate || app.dialog.is_some() {
        return false;
    }
    let plain = key.modifiers.difference(KeyModifiers::SHIFT).is_empty();
    match key.code {
        KeyCode::Char('1') if plain => {
            set_mode(app, SidebarMode::Sessions);
            return true;
        }
        KeyCode::Char('2') if plain => {
            set_mode(app, SidebarMode::Files);
            return true;
        }
        KeyCode::Char('F') if plain => {
            toggle_mode(app);
            return true;
        }
        _ => {}
    }
    if app.files.mode != SidebarMode::Files {
        return false;
    }
    if key.code == KeyCode::Char('\u{10}')
        || (key.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(key.code, KeyCode::Char('p' | 'P')))
    {
        open_palette(app);
        return true;
    }
    if !plain {
        return false;
    }
    let docked = preview_docked(app);
    match key.code {
        KeyCode::Up | KeyCode::Char('k') => move_selection(app, -1),
        KeyCode::Down | KeyCode::Char('j') => move_selection(app, 1),
        KeyCode::Left | KeyCode::Char('h') => {
            if let Some(tree) = &mut app.files.tree {
                tree.collapse();
            }
        }
        KeyCode::Right | KeyCode::Char('l') => {
            if let Some(tree) = &mut app.files.tree {
                tree.expand();
            }
        }
        KeyCode::Enter => enter(app),
        KeyCode::Char('p') => paste(app, false, outcome),
        KeyCode::Char('P') => paste(app, true, outcome),
        KeyCode::Char('.') => toggle_hidden(app),
        KeyCode::Char('r') => refresh(app),
        KeyCode::Char('o') => pin(app),
        KeyCode::PageUp | KeyCode::PageDown if docked => {
            scroll_preview(app, key.code == KeyCode::PageDown, area);
        }
        KeyCode::PageUp => move_selection(app, -TREE_PAGE),
        KeyCode::PageDown => move_selection(app, TREE_PAGE),
        KeyCode::Esc if app.files.preview.is_some() => {
            if let Some((id, _)) = app.files.preview.take().and_then(|preview| preview.pending) {
                app.files.orphans.insert(id);
            }
        }
        KeyCode::Esc => set_mode(app, SidebarMode::Sessions),
        _ => return false,
    }
    true
}

pub fn scroll(app: &mut App, up: bool) {
    move_selection(app, if up { -3 } else { 3 });
}

fn move_selection(app: &mut App, delta: isize) {
    if let Some(tree) = &mut app.files.tree {
        tree.move_by(delta);
    }
}

fn text_matches(words: &[String], text: &str) -> bool {
    let text = text.to_lowercase();
    words.iter().all(|word| {
        let mut chars = text.chars();
        word.chars().all(|c| chars.any(|candidate| candidate == c))
    })
}

pub fn palette_rows(app: &App, query: &str) -> Option<Vec<ResultRow>> {
    let wanted = files_query(query)?;
    let find = &app.files.find;
    if !find.requested || root(app).as_deref() != Some(find.root.as_str()) {
        return Some(Vec::new());
    }
    let words: Vec<String> = wanted.split_whitespace().map(str::to_lowercase).collect();
    let mut matches: Vec<&Match> = find
        .matches
        .iter()
        .filter(|candidate| find.query == wanted || text_matches(&words, &candidate.path))
        .collect();
    matches.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.path.len().cmp(&b.path.len()))
            .then_with(|| a.path.cmp(&b.path))
    });
    let context = format!("File · {}", files_tree::base_name(&find.root));
    Some(
        matches
            .into_iter()
            .map(|candidate| ResultRow {
                target: Target::File(candidate.path.clone()),
                title: candidate.path.clone(),
                context: context.clone(),
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::controller::Outcome;

    fn app() -> App {
        let mut app = App::new(7);
        app.event(json!({"type":"capabilities","workspace":"/work","programs":[],"files":true}))
            .unwrap();
        app.event(json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"s","name":"agent","cwd":"/work","program":"claude","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]}))
        .unwrap();
        app.dialog = None;
        app
    }

    fn press(app: &mut App, code: KeyCode) -> Vec<Value> {
        let mut outcome = Outcome::default();
        assert!(key(
            app,
            KeyEvent::new(code, KeyModifiers::NONE),
            Rect::new(0, 0, 120, 40),
            &mut outcome
        ));
        outcome.commands.extend(sync(app));
        outcome.commands
    }

    fn reply(app: &mut App, command: &Value, mut event: Value) -> Vec<Value> {
        event["requestId"] = command["requestId"].clone();
        app.event(event).unwrap()
    }

    fn entries(names: &[(&str, &str)]) -> Value {
        Value::Array(
            names
                .iter()
                .map(|(name, kind)| json!({"name":name,"kind":kind,"size":3,"modifiedMs":1,"status":null,"ignored":false}))
                .collect(),
        )
    }

    fn listed(app: &mut App) {
        let commands = press(app, KeyCode::Char('2'));
        assert_eq!(commands.len(), 1);
        assert_eq!(
            commands[0],
            json!({"type":"listEntries","directory":"/work","showHidden":false,"requestId":commands[0]["requestId"]})
        );
        let follow = reply(
            app,
            &commands[0],
            json!({"type":"entries","directory":"/work","root":"/work","entries":entries(&[("src","dir"),("a.txt","file")]),"truncated":false,"statusTruncated":false}),
        );
        assert!(follow.is_empty());
    }

    #[test]
    fn files_mode_keys_switch_and_unsupported_hosts_send_nothing() {
        let mut app = app();
        app.host_features = json!({"type":"capabilities"});
        assert!(press(&mut app, KeyCode::Char('F')).is_empty());
        assert_eq!(app.files.mode, SidebarMode::Files);
        assert!(app.notice.contains("Update nesvo-host"));
        press(&mut app, KeyCode::Char('1'));
        assert_eq!(app.files.mode, SidebarMode::Sessions);
        let mut outcome = Outcome::default();
        assert!(!key(
            &mut app,
            KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE),
            Rect::new(0, 0, 80, 24),
            &mut outcome
        ));
    }

    #[test]
    fn files_commands_list_expand_preview_page_hidden_and_refresh() {
        let mut app = app();
        listed(&mut app);
        let expand = press(&mut app, KeyCode::Char('l'));
        assert_eq!(expand.len(), 1);
        assert_eq!(expand[0]["type"], "listEntries");
        assert_eq!(expand[0]["directory"], "/work/src");
        reply(
            &mut app,
            &expand[0],
            json!({"type":"entries","entries":entries(&[("main.rs","file")]),"truncated":false}),
        );
        press(&mut app, KeyCode::Char('j'));
        let read = press(&mut app, KeyCode::Enter);
        assert_eq!(
            read,
            [
                json!({"type":"readFile","path":"/work/src/main.rs","offset":0,"requestId":read[0]["requestId"]})
            ]
        );
        let text: String = (0..200).map(|n| format!("line {n}\n")).collect();
        reply(
            &mut app,
            &read[0],
            json!({"type":"file","path":"/work/src/main.rs","size":9000,"offset":0,"length":text.len(),"text":text,"truncated":true,"encoding":"utf8"}),
        );
        assert!(preview_docked(&app));
        let mut next = Vec::new();
        for _ in 0..8 {
            next.extend(press(&mut app, KeyCode::PageDown));
        }
        assert_eq!(next.len(), 1);
        assert_eq!(next[0]["type"], "readFile");
        assert_eq!(next[0]["offset"], text.len());
        reply(
            &mut app,
            &next[0],
            json!({"type":"file","offset":text.len(),"length":4,"text":"end\n","size":9000,"truncated":false}),
        );
        let preview = app.files.preview.as_ref().unwrap();
        assert_eq!(preview.line_count(), 201);
        assert!(!preview.truncated);

        let hidden = press(&mut app, KeyCode::Char('.'));
        assert_eq!(hidden.len(), 1);
        assert_eq!(hidden[0]["showHidden"], true);
        assert_eq!(hidden[0]["directory"], "/work");
        let src = reply(
            &mut app,
            &hidden[0],
            json!({"type":"entries","entries":entries(&[(".env","file"),("src","dir")]),"truncated":false}),
        );
        assert_eq!(src.len(), 1);
        assert_eq!(src[0]["directory"], "/work/src");
        assert_eq!(src[0]["showHidden"], true);
        reply(
            &mut app,
            &src[0],
            json!({"type":"entries","entries":entries(&[("main.rs","file")]),"truncated":false}),
        );

        let refreshed = press(&mut app, KeyCode::Char('r'));
        let kinds: Vec<_> = refreshed
            .iter()
            .map(|command| (command["type"].clone(), command["offset"].clone()))
            .collect();
        assert_eq!(
            kinds,
            [
                (json!("readFile"), json!(0)),
                (json!("listEntries"), Value::Null)
            ]
        );
        assert_eq!(refreshed[1]["directory"], "/work");
    }

    #[test]
    fn files_paste_sends_lease_bound_relative_and_absolute_paths() {
        let mut app = app();
        listed(&mut app);
        app.panes[0] = Some("s".into());
        app.event(json!({"type":"subscribed","sessionId":"s","cols":80,"rows":24}))
            .unwrap();
        assert!(press(&mut app, KeyCode::Char('p')).is_empty());
        assert!(app.notice.contains("Read-only"));
        app.event(json!({"type":"control","sessionId":"s","controllerId":7,"cols":80,"rows":24,"leaseId":"lease"}))
            .unwrap();
        app.sessions[0].controller_id = Some(7);
        press(&mut app, KeyCode::Char('j'));
        let relative = press(&mut app, KeyCode::Char('p'));
        assert_eq!(relative.len(), 1);
        assert_eq!(relative[0]["type"], "input");
        assert_eq!(relative[0]["leaseId"], "lease");
        assert!(relative[0]["data"].as_str().unwrap().contains("a.txt"));
        assert!(!relative[0]["data"].as_str().unwrap().contains("/work"));
        let absolute = press(&mut app, KeyCode::Char('P'));
        assert!(
            absolute[0]["data"]
                .as_str()
                .unwrap()
                .contains("/work/a.txt")
        );
    }

    #[test]
    fn files_paste_refuses_paths_with_newlines_or_control_characters() {
        assert!(pasteable("src/main.rs"));
        assert!(pasteable(r"C:\work\a b.txt"));
        assert!(!pasteable("src/a\nrm -rf ~"));
        assert!(!pasteable("src/\u{1b}[2J"));
        assert!(!pasteable(""));
        let mut app = app();
        listed(&mut app);
        let expand = press(&mut app, KeyCode::Char('l'));
        reply(
            &mut app,
            &expand[0],
            json!({"type":"entries","entries":entries(&[("evil\nrm -rf ~","file"),("ok.rs","file")]),"truncated":false}),
        );
        let rows: Vec<String> = app
            .files
            .tree
            .as_ref()
            .unwrap()
            .rows()
            .into_iter()
            .map(|row| row.path)
            .collect();
        assert_eq!(rows, ["src", "src/ok.rs", "a.txt"]);
    }

    #[test]
    fn files_pin_overrides_the_session_root_and_unpins() {
        let mut app = app();
        listed(&mut app);
        assert!(press(&mut app, KeyCode::Char('o')).iter().any(|command| {
            command["type"] == "listEntries" && command["directory"] == "/work/src"
        }));
        assert_eq!(app.files.pinned.as_deref(), Some("/work/src"));
        assert_eq!(app.files.tree.as_ref().unwrap().root(), "/work/src");
        press(&mut app, KeyCode::Char('o'));
        assert_eq!(app.files.pinned, None);
        assert_eq!(app.files.tree.as_ref().unwrap().root(), "/work");
    }

    #[test]
    fn files_errors_busy_retries_then_binary_and_outside_root_show_in_the_preview() {
        let mut app = app();
        listed(&mut app);
        press(&mut app, KeyCode::Char('j'));
        let read = press(&mut app, KeyCode::Enter);
        let mut command = read[0].clone();
        for _ in 0..BUSY_RETRIES {
            let retried = reply(
                &mut app,
                &command,
                json!({"type":"error","code":"busy","message":"Another file request is running on this connection"}),
            );
            assert_eq!(retried.len(), 1, "busy requests are retried");
            assert_eq!(retried[0]["type"], "readFile");
            assert!(app.notice.is_empty());
            command = retried[0].clone();
        }
        assert!(
            reply(
                &mut app,
                &command,
                json!({"type":"error","code":"busy","message":"busy"})
            )
            .is_empty()
        );
        assert!(
            app.files
                .preview
                .as_ref()
                .unwrap()
                .error
                .as_deref()
                .unwrap()
                .contains("busy")
        );

        let read = press(&mut app, KeyCode::Enter);
        reply(
            &mut app,
            &read[0],
            json!({"type":"error","code":"binary","message":"Binary files are not previewed"}),
        );
        assert_eq!(
            app.files.preview.as_ref().unwrap().error.as_deref(),
            Some("Binary file: the preview shows text only.")
        );
        let read = press(&mut app, KeyCode::Enter);
        reply(
            &mut app,
            &read[0],
            json!({"type":"error","code":"outside_root","message":"Link target is outside the folder or its repository"}),
        );
        assert!(app.notice.contains("outside the folder"));
        assert!(press(&mut app, KeyCode::Esc).is_empty());
        assert!(app.files.preview.is_none());
        press(&mut app, KeyCode::Esc);
        assert_eq!(app.files.mode, SidebarMode::Sessions);
    }

    #[test]
    fn files_listing_errors_fail_the_folder_row_and_late_replies_are_ignored() {
        let mut app = app();
        listed(&mut app);
        let expand = press(&mut app, KeyCode::Char('l'));
        reply(
            &mut app,
            &expand[0],
            json!({"type":"error","code":"outside_root","message":"Link target is outside the folder or its repository"}),
        );
        let tree = app.files.tree.as_ref().unwrap();
        assert!(matches!(
            tree.rows()[1].kind,
            files_tree::RowKind::Failed(message) if message.contains("outside")
        ));
        assert!(sync(&mut app).is_empty());
        let late = json!({"type":"entries","requestId":"tui-7-999","entries":[],"truncated":false});
        assert!(app.event(late).unwrap().is_empty());
    }

    #[test]
    fn files_palette_hash_prefix_requests_find_and_ranks_by_score_then_length() {
        let mut app = app();
        let mut outcome = Outcome::default();
        app.files.mode = SidebarMode::Files;
        key(
            &mut app,
            KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL),
            Rect::new(0, 0, 80, 24),
            &mut outcome,
        );
        assert!(matches!(&app.dialog, Some(Dialog::QuickSwitch { query, .. }) if query == "#"));
        let commands = sync(&mut app);
        let find = commands
            .iter()
            .find(|command| command["type"] == "findFiles")
            .unwrap()
            .clone();
        assert_eq!(find["root"], "/work");
        assert_eq!(find["query"], "");
        assert_eq!(find["limit"], FIND_LIMIT);
        if let Some(Dialog::QuickSwitch { query, .. }) = &mut app.dialog {
            *query = "#main".into();
        }
        assert!(
            sync(&mut app)
                .iter()
                .all(|command| command["type"] != "findFiles")
        );
        let again = reply(
            &mut app,
            &find,
            json!({"type":"files","root":"/work","matches":[
                {"path":"README.md","score":1},{"path":"src/main.rs","score":40},{"path":"docs/main.md","score":40}
            ],"scanned":3,"truncated":false}),
        );
        assert_eq!(again.len(), 1);
        assert_eq!(again[0]["query"], "main");
        let stale: Vec<_> = app
            .palette_results("#main")
            .into_iter()
            .map(|row| row.title)
            .collect();
        assert_eq!(stale, ["src/main.rs", "docs/main.md"]);
        reply(
            &mut app,
            &again[0],
            json!({"type":"files","root":"/work","matches":[
                {"path":"src/main.rs","score":40},{"path":"lib/domain.rs","score":5},{"path":"docs/main.md","score":40}
            ],"scanned":3,"truncated":false}),
        );
        let rows = app.palette_results("#main");
        let titles: Vec<_> = rows.iter().map(|row| row.title.as_str()).collect();
        assert_eq!(titles, ["src/main.rs", "docs/main.md", "lib/domain.rs"]);
        assert_eq!(rows[0].target, Target::File("src/main.rs".into()));
        assert_eq!(rows[0].context, "File · work");
        assert!(crate::palette::eligible(&app, "#main", &rows[2].target));
        assert!(!crate::palette::eligible(&app, "main", &rows[2].target));
        assert!(
            app.palette_results("#main")
                .iter()
                .all(|row| row.target.session_id().is_none())
        );
        assert_eq!(app.palette_index(), Some(0));
        open_found(&mut app, "src/main.rs");
        let opened = sync(&mut app);
        assert!(
            opened
                .iter()
                .any(|command| command["type"] == "readFile"
                    && command["path"] == "/work/src/main.rs")
        );
        assert!(app.files.tree.as_ref().unwrap().is_expanded("src"));
    }

    #[test]
    fn files_saved_state_round_trips_caps_and_tolerates_malformed_fields() {
        let mut app = app();
        listed(&mut app);
        press(&mut app, KeyCode::Char('l'));
        app.files.pinned = None;
        let saved = app.files.capture();
        assert_eq!(saved.sidebar_mode, SidebarMode::Files);
        assert_eq!(
            saved.roots,
            [SavedRoot {
                root: "/work".into(),
                expanded: vec!["src".into()]
            }]
        );
        let mut restored = App::new(8);
        restored
            .files
            .restore(&serde_json::from_value(serde_json::to_value(&saved).unwrap()).unwrap());
        assert_eq!(restored.files.capture(), saved);

        let malformed: Saved = serde_json::from_value(json!({
            "sidebar_mode":"diagonal","pinned":7,"show_hidden":"yes",
            "roots":[{"root":"/a","expanded":["ok","../bad",""]},{"root":"","expanded":["x"]}]
        }))
        .unwrap();
        assert_eq!(malformed.sidebar_mode, SidebarMode::Sessions);
        let mut state = FilesState::default();
        state.restore(&malformed);
        assert_eq!(state.pinned, None);
        assert_eq!(
            state.capture().roots,
            [SavedRoot {
                root: "/a".into(),
                expanded: vec!["ok".into()]
            }]
        );

        let mut big = FilesState::default();
        big.restore(&Saved {
            roots: (0..MAX_ROOTS * 2)
                .map(|n| SavedRoot {
                    root: format!("/root/{n}"),
                    expanded: (0..files_tree::MAX_EXPANDED * 2)
                        .map(|m| format!("folder-{m}"))
                        .collect(),
                })
                .collect(),
            ..Default::default()
        });
        let captured = big.capture();
        assert!(serde_json::to_vec(&captured).unwrap().len() <= SAVED_BYTES + 256);
        assert!(captured.roots.len() <= MAX_ROOTS);
        assert!(
            captured
                .roots
                .iter()
                .all(|root| root.expanded.len() <= files_tree::MAX_EXPANDED)
        );
    }

    #[test]
    fn files_workspace_layout_persists_mode_pinned_folder_and_expanded_set() {
        let mut app = app();
        listed(&mut app);
        press(&mut app, KeyCode::Char('l'));
        app.files.pinned = Some("/work".into());
        let path =
            std::env::temp_dir().join(format!("nesvo-files-layout-{}.json", std::process::id()));
        let captured = crate::workspace_layout::WorkspaceLayout::capture(&app);
        captured.save(&path).unwrap();
        let loaded = crate::workspace_layout::WorkspaceLayout::load(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        let mut restored = self::app();
        let commands = loaded.apply(&mut restored);
        assert!(
            commands
                .iter()
                .all(|command| command["type"] != "acquireControl")
        );
        assert_eq!(restored.files.mode, SidebarMode::Files);
        assert_eq!(restored.files.pinned.as_deref(), Some("/work"));
        let listing = sync(&mut restored);
        assert_eq!(listing.len(), 1);
        assert_eq!(listing[0]["directory"], "/work");
        reply(
            &mut restored,
            &listing[0],
            json!({"type":"entries","entries":entries(&[("src","dir")]),"truncated":false}),
        );
        assert!(restored.files.tree.as_ref().unwrap().is_expanded("src"));
    }
}
