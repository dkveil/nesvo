use crate::{
    controller::Outcome,
    layouts::Role,
    model::{App, Mode},
    notes::{self, Editor, LastNote, Saved, Summary},
};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::layout::Rect;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};

pub const MAX_IN_FLIGHT: usize = 2;
const PREFETCH_LIMIT: usize = 64;
const CACHE_BYTES: usize = 4 * 1024 * 1024;
const CAPTURE_ATTEMPTS: u8 = 3;
const NAME_ATTEMPTS: usize = 5;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum View {
    #[default]
    Browse,
    Search,
    Edit,
    ConfirmDelete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Purpose {
    Preview,
    Edit,
    Prefetch,
    Capture,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Want {
    List(String),
    Read(String, Purpose),
    Save {
        path: String,
        text: String,
        expected: Option<String>,
    },
    Capture {
        path: String,
        text: String,
        expected: Option<String>,
    },
    Delete(String),
}

impl Want {
    fn command(&self) -> Value {
        match self {
            Self::List(root) => json!({"type":"listNotes","root":root}),
            Self::Read(path, _) => json!({"type":"readNote","path":path}),
            Self::Save {
                path,
                text,
                expected,
            }
            | Self::Capture {
                path,
                text,
                expected,
            } => {
                json!({"type":"writeNote","path":path,"text":text,"expectedRevision":expected})
            }
            Self::Delete(path) => json!({"type":"deleteNote","path":path}),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Listing {
    pub root: String,
    pub directory: String,
    pub location: String,
    pub repository: Option<String>,
    pub notes: Vec<Summary>,
    pub truncated: bool,
}

impl Listing {
    pub fn place(&self) -> String {
        match &self.repository {
            Some(repository) => crate::files_tree::base_name(repository).to_owned(),
            None => "host notes".into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Loaded {
    pub text: String,
    pub revision: String,
    size: u64,
    modified_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Draft {
    pub path: Option<String>,
    pub name: Option<String>,
    pub revision: Option<String>,
    pub editor: Editor,
    pub dirty: bool,
    pub saving: bool,
    pub conflict: Option<Option<String>>,
    avoid: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CaptureInput {
    pub text: String,
    pub date: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CaptureJob {
    line: String,
    root: String,
    date: String,
    time: String,
    attempts: u8,
    path: Option<String>,
}

#[derive(Debug, Default)]
pub struct NotesState {
    pub open: bool,
    pub focused: bool,
    pub view: View,
    pub listing: Option<Listing>,
    pub selected: Option<String>,
    pub query: String,
    pub contents: HashMap<String, Loaded>,
    pub failed: HashMap<String, String>,
    pub draft: Option<Draft>,
    pub capture: Option<CaptureInput>,
    pub error: Option<String>,
    pub preview_scroll: usize,
    root: Option<String>,
    last: Vec<LastNote>,
    queue: VecDeque<Want>,
    pending: HashMap<String, Want>,
    job: Option<CaptureJob>,
}

impl NotesState {
    pub fn saved(&self) -> Saved {
        Saved {
            last: self.last.clone(),
        }
    }

    pub fn restore(&mut self, saved: &Saved) {
        self.last = saved.sanitized();
    }

    pub fn disconnected(&mut self) {
        self.pending.clear();
        self.queue.clear();
        self.job = None;
        self.capture = None;
        self.root = None;
        if let Some(draft) = self.draft.as_mut() {
            draft.saving = false;
        }
    }

    pub fn loading(&self) -> bool {
        self.pending
            .values()
            .chain(self.queue.iter())
            .any(|want| matches!(want, Want::List(_)))
    }

    pub fn visible(&self) -> Vec<&Summary> {
        let Some(listing) = &self.listing else {
            return Vec::new();
        };
        listing
            .notes
            .iter()
            .filter(|summary| {
                notes::matches(
                    &self.query,
                    summary,
                    self.contents
                        .get(&summary.path)
                        .map(|loaded| loaded.text.as_str()),
                )
            })
            .collect()
    }

    pub fn selected_summary(&self) -> Option<&Summary> {
        let selected = self.selected.as_deref()?;
        self.listing
            .as_ref()?
            .notes
            .iter()
            .find(|summary| summary.path == selected)
    }

    pub fn selected_index(&self) -> Option<usize> {
        let selected = self.selected.as_deref()?;
        self.visible()
            .iter()
            .position(|summary| summary.path == selected)
    }

    fn remembered(&self, directory: &str) -> Option<&str> {
        self.last
            .iter()
            .find(|entry| entry.directory == directory)
            .map(|entry| entry.name.as_str())
    }

    fn enqueue(&mut self, want: Want, urgent: bool) {
        if self.queue.contains(&want) || self.pending.values().any(|known| *known == want) {
            return;
        }
        if urgent {
            self.queue.push_front(want);
        } else {
            self.queue.push_back(want);
        }
    }

    fn requested(&self, path: &str) -> bool {
        self.pending
            .values()
            .chain(self.queue.iter())
            .any(|want| matches!(want, Want::Read(known, _) if known == path))
    }

    fn cache(&mut self, path: String, loaded: Loaded) {
        let used: usize = self
            .contents
            .iter()
            .filter(|(known, _)| **known != path)
            .map(|(_, loaded)| loaded.text.len())
            .sum();
        if used + loaded.text.len() > CACHE_BYTES {
            let keep = self.selected.clone();
            self.contents
                .retain(|known, _| Some(known.as_str()) == keep.as_deref());
        }
        self.contents.insert(path, loaded);
    }

    fn refresh(&mut self) {
        if let Some(root) = self.root.clone() {
            self.enqueue(Want::List(root), false);
        }
    }

    fn reconcile(&mut self, listing: Listing) {
        let moved = self
            .listing
            .as_ref()
            .is_none_or(|known| known.directory != listing.directory);
        if moved {
            self.contents.clear();
            self.selected = None;
            self.preview_scroll = 0;
        } else {
            let fresh: HashMap<&str, (u64, Option<u64>)> = listing
                .notes
                .iter()
                .map(|summary| (summary.path.as_str(), (summary.size, summary.modified_ms)))
                .collect();
            self.contents.retain(|path, loaded| {
                fresh.get(path.as_str()) == Some(&(loaded.size, loaded.modified_ms))
            });
        }
        self.failed.clear();
        let present = |path: &str| listing.notes.iter().any(|summary| summary.path == path);
        if self.selected.as_deref().is_none_or(|path| !present(path)) {
            let remembered = self
                .remembered(&listing.directory)
                .map(|name| notes::join(&listing.directory, name))
                .filter(|path| present(path));
            self.selected = remembered.or_else(|| listing.notes.first().map(|s| s.path.clone()));
            self.preview_scroll = 0;
        }
        self.listing = Some(listing);
    }
}

pub fn supported(app: &App) -> bool {
    app.host_features["notes"] == true
}

pub fn project_root(app: &App) -> Option<String> {
    app.active_session()
        .or_else(|| app.review_candidate())
        .map(|session| session.cwd.clone())
        .or_else(|| app.capabilities.as_ref().map(|caps| caps.workspace.clone()))
        .filter(|root| notes::valid_directory(root))
}

pub fn leaf_index(app: &App) -> Option<usize> {
    app.pane_tree().position(Role::Notes)
}

pub fn captures(app: &App) -> bool {
    app.dialog.is_none() && app.notes.open && app.notes.focused
}

pub fn open(app: &mut App, focus: bool) -> Vec<Value> {
    if !app.connected {
        app.notice = "Reconnect to the host before opening Notes.".into();
        return Vec::new();
    }
    if !supported(app) {
        app.notice = "Update nesvo-host to use Notes.".into();
        return Vec::new();
    }
    app.notes.open = true;
    app.notes.focused |= focus;
    app.notes.refresh();
    app.notice.clear();
    sync(app)
}

pub fn close(app: &mut App) {
    let notes = &mut app.notes;
    notes.open = false;
    notes.focused = false;
    if notes.view != View::Edit {
        notes.view = View::Browse;
    }
}

pub fn sync(app: &mut App) -> Vec<Value> {
    let mut commands = Vec::new();
    if !app.connected || !supported(app) {
        return commands;
    }
    if app.notes.open {
        let root = project_root(app);
        if root.is_some() && root != app.notes.root {
            app.notes.root = root;
            app.notes.refresh();
        }
        if matches!(app.notes.view, View::Browse | View::ConfirmDelete)
            && let Some(path) = app.notes.selected.clone()
            && !app.notes.contents.contains_key(&path)
            && !app.notes.failed.contains_key(&path)
            && !app.notes.requested(&path)
        {
            app.notes
                .queue
                .retain(|want| !matches!(want, Want::Read(_, Purpose::Preview)));
            app.notes.enqueue(Want::Read(path, Purpose::Preview), false);
        }
    }
    while app.notes.pending.len() < MAX_IN_FLIGHT {
        let Some(want) = app.notes.queue.pop_front() else {
            break;
        };
        let command = app.request(want.command());
        if let Some(id) = command["requestId"].as_str() {
            app.notes.pending.insert(id.to_owned(), want);
        }
        commands.push(command);
    }
    commands
}

fn loaded(event: &Value) -> Loaded {
    Loaded {
        text: event["text"].as_str().unwrap_or_default().to_owned(),
        revision: event["revision"].as_str().unwrap_or_default().to_owned(),
        size: event["size"].as_u64().unwrap_or(0),
        modified_ms: event["modifiedMs"].as_u64(),
    }
}

fn name_of(path: &str) -> String {
    crate::files_tree::base_name(path).to_owned()
}

fn draft_for(path: &str, loaded: &Loaded) -> Draft {
    Draft {
        path: Some(path.to_owned()),
        name: Some(name_of(path)),
        revision: Some(loaded.revision.clone()),
        editor: Editor::new(&loaded.text),
        ..Default::default()
    }
}

fn begin_edit(app: &mut App, path: &str) {
    let Some(loaded) = app.notes.contents.get(path) else {
        return;
    };
    let draft = draft_for(path, loaded);
    app.notes.draft = Some(draft);
    app.notes.view = View::Edit;
    remember_path(app, path);
}

fn remember_path(app: &mut App, path: &str) {
    if let Some(listing) = &app.notes.listing {
        let directory = listing.directory.clone();
        notes::remember(&mut app.notes.last, &directory, &name_of(path));
    }
}

pub fn host_event(app: &mut App, event: &Value) -> bool {
    let Some(id) = event["requestId"].as_str() else {
        return false;
    };
    let Some(want) = app.notes.pending.remove(id) else {
        return false;
    };
    app.notes.error = None;
    match (want, event["type"].as_str().unwrap_or_default()) {
        (Want::List(root), "notes") => {
            let listing = Listing {
                root: root.clone(),
                directory: event["directory"].as_str().unwrap_or_default().to_owned(),
                location: event["location"].as_str().unwrap_or_default().to_owned(),
                repository: event["repository"].as_str().map(str::to_owned),
                notes: serde_json::from_value(event["notes"].clone()).unwrap_or_default(),
                truncated: event["truncated"] == true,
            };
            let directory = listing.directory.clone();
            app.notes.reconcile(listing);
            if let Some(job) = app.notes.job.as_mut()
                && job.path.is_none()
                && job.root == root
            {
                let path = notes::join(&directory, &notes::today_name(&job.date));
                job.path = Some(path.clone());
                app.notes.enqueue(Want::Read(path, Purpose::Capture), true);
            }
        }
        (Want::Read(path, purpose), "note") => {
            let loaded = loaded(event);
            match purpose {
                Purpose::Capture => continue_capture(app, &path, Some(loaded)),
                Purpose::Edit => {
                    app.notes.cache(path.clone(), loaded);
                    if app.notes.view != View::Edit {
                        begin_edit(app, &path);
                    }
                }
                Purpose::Preview | Purpose::Prefetch => app.notes.cache(path, loaded),
            }
        }
        (Want::Save { text, .. }, "noteSaved") => saved(app, event, &text),
        (Want::Capture { path, text, .. }, "noteSaved") => {
            let revision = event["revision"].as_str().unwrap_or_default().to_owned();
            app.notes.cache(
                path.clone(),
                Loaded {
                    size: event["size"].as_u64().unwrap_or(0),
                    modified_ms: event["modifiedMs"].as_u64(),
                    text: text.clone(),
                    revision: revision.clone(),
                },
            );
            if let Some(draft) = app.notes.draft.as_mut()
                && draft.path.as_deref() == Some(path.as_str())
                && !draft.dirty
            {
                let scroll = draft.editor.scroll;
                draft.editor = Editor::new(&text);
                draft.editor.scroll = scroll;
                draft.revision = Some(revision);
            }
            app.notes.job = None;
            app.notice = format!("Captured to {}", name_of(&path));
            app.notes.refresh();
        }
        (Want::Delete(path), "noteDeleted") => {
            app.notes.contents.remove(&path);
            if app
                .notes
                .draft
                .as_ref()
                .is_some_and(|draft| draft.path.as_deref() == Some(path.as_str()))
            {
                app.notes.draft = None;
                if app.notes.view == View::Edit {
                    app.notes.view = View::Browse;
                }
            }
            if app.notes.selected.as_deref() == Some(path.as_str()) {
                let visible = app.notes.visible();
                let index = visible.iter().position(|summary| summary.path == path);
                let next = index
                    .and_then(|index| {
                        visible
                            .get(index + 1)
                            .or_else(|| visible.get(index.checked_sub(1)?))
                    })
                    .map(|summary| summary.path.clone());
                app.notes.selected = next;
            }
            let name = name_of(&path);
            app.notes.last.retain(|entry| entry.name != name);
            app.notice = format!("Deleted {name}");
            app.notes.refresh();
        }
        _ => {}
    }
    true
}

fn saved(app: &mut App, event: &Value, text: &str) {
    let path = event["path"].as_str().unwrap_or_default().to_owned();
    let revision = event["revision"].as_str().unwrap_or_default().to_owned();
    if let Some(draft) = app.notes.draft.as_mut() {
        draft.saving = false;
        draft.conflict = None;
        draft.avoid.clear();
        draft.path = Some(path.clone());
        draft.name = Some(name_of(&path));
        draft.revision = Some(revision.clone());
        draft.dirty = draft.editor.text() != text;
    }
    app.notes.cache(
        path.clone(),
        Loaded {
            text: text.to_owned(),
            revision,
            size: event["size"].as_u64().unwrap_or(0),
            modified_ms: event["modifiedMs"].as_u64(),
        },
    );
    app.notes.selected = Some(path.clone());
    remember_path(app, &path);
    app.notice = format!("Saved {}", name_of(&path));
    app.notes.refresh();
}

fn continue_capture(app: &mut App, path: &str, current: Option<Loaded>) {
    let Some(job) = app.notes.job.as_ref() else {
        return;
    };
    let text = notes::captured(
        current.as_ref().map(|loaded| loaded.text.as_str()),
        &job.date,
        &job.time,
        &job.line,
    );
    if text.len() > notes::NOTE_BYTES {
        app.notes.job = None;
        app.notice = format!("{} is full: notes are limited to 64 KiB.", name_of(path));
        return;
    }
    let want = Want::Capture {
        path: path.to_owned(),
        text,
        expected: current.map(|loaded| loaded.revision),
    };
    app.notes.enqueue(want, true);
}

fn describe(code: &str, message: &str) -> String {
    match code {
        "too_large" => "Notes are limited to 64 KiB.".into(),
        "binary" | "not_text" => "This note is not UTF-8 text.".into(),
        "outside_notes" => "This note is outside the notes folder.".into(),
        "busy" => "The host is busy with other notes requests; try again.".into(),
        _ => message.to_owned(),
    }
}

pub fn host_error(app: &mut App, event: &Value) {
    let Some(id) = event["requestId"].as_str() else {
        return;
    };
    let Some(want) = app.notes.pending.remove(id) else {
        return;
    };
    let code = event["code"].as_str().unwrap_or_default();
    let message = describe(
        code,
        event["message"]
            .as_str()
            .unwrap_or("The host refused the notes request."),
    );
    match want {
        Want::List(_) => app.notes.error = Some(message.clone()),
        Want::Read(path, Purpose::Capture) if code == "not_found" => {
            return continue_capture(app, &path, None);
        }
        Want::Read(_, Purpose::Capture) | Want::Capture { .. } if code != "stale_revision" => {
            app.notes.job = None;
            message.clone_into(&mut app.notice);
            return;
        }
        Want::Capture { path, .. } => {
            let retry = app.notes.job.as_mut().is_some_and(|job| {
                job.attempts += 1;
                job.attempts < CAPTURE_ATTEMPTS
            });
            if retry {
                app.notes.enqueue(Want::Read(path, Purpose::Capture), true);
                app.notice.clear();
            } else {
                app.notes.job = None;
                app.notice = "The note kept changing; nothing was captured.".into();
            }
            return;
        }
        Want::Read(path, Purpose::Preview | Purpose::Prefetch | Purpose::Edit) => {
            app.notes.failed.insert(path, message.clone());
        }
        Want::Save { path, .. } => {
            let revision = event["revision"].as_str().map(str::to_owned);
            let Some(draft) = app.notes.draft.as_mut() else {
                return;
            };
            draft.saving = false;
            if code == "stale_revision" && draft.revision.is_none() && draft.conflict.is_none() {
                draft.avoid.push(name_of(&path));
                if draft.avoid.len() < NAME_ATTEMPTS {
                    app.notice.clear();
                    return save(app);
                }
            }
            if code == "stale_revision" {
                draft.conflict = Some(revision);
                app.notice =
                    "This note changed elsewhere; your text is kept. Ctrl+S saves over it.".into();
                return;
            }
        }
        Want::Read(_, Purpose::Capture) => {}
        Want::Delete(_) => {}
    }
    app.notice = message;
}

fn save(app: &mut App) {
    let Some(listing) = app.notes.listing.clone() else {
        app.notice = "The notes folder is still loading.".into();
        return;
    };
    let Some(draft) = app.notes.draft.as_mut() else {
        return;
    };
    if draft.saving {
        return;
    }
    let text = draft.editor.text();
    let (path, expected) = match (&draft.path, &draft.conflict) {
        (Some(path), Some(conflict)) => (path.clone(), conflict.clone()),
        (Some(path), None) => (path.clone(), draft.revision.clone()),
        (None, _) => {
            let mut taken: Vec<String> = listing.notes.iter().map(|s| s.name.clone()).collect();
            taken.extend(draft.avoid.iter().cloned());
            let name = notes::unique_name(&text, &taken);
            (notes::join(&listing.directory, &name), None)
        }
    };
    draft.saving = true;
    draft.conflict = None;
    app.notes.enqueue(
        Want::Save {
            path,
            text,
            expected,
        },
        true,
    );
}

fn leave_edit(app: &mut App) {
    app.notes.view = View::Browse;
    let Some(draft) = app.notes.draft.as_ref() else {
        return;
    };
    if draft.path.is_none() && draft.editor.text().trim().is_empty() {
        app.notes.draft = None;
        return;
    }
    if draft.dirty && draft.conflict.is_none() {
        save(app);
    }
}

fn move_selection(app: &mut App, delta: isize) {
    let visible = app.notes.visible();
    if visible.is_empty() {
        return;
    }
    let index = app.notes.selected_index().map_or(0, |index| {
        index.saturating_add_signed(delta).min(visible.len() - 1)
    });
    let path = visible[index].path.clone();
    if app.notes.selected.as_deref() != Some(path.as_str()) {
        app.notes.selected = Some(path);
        app.notes.preview_scroll = 0;
    }
}

fn start_search(app: &mut App) {
    app.notes.view = View::Search;
    let wanted: Vec<String> = app
        .notes
        .listing
        .as_ref()
        .map(|listing| {
            listing
                .notes
                .iter()
                .map(|summary| summary.path.clone())
                .take(PREFETCH_LIMIT)
                .collect()
        })
        .unwrap_or_default();
    for path in wanted {
        if !app.notes.contents.contains_key(&path)
            && !app.notes.failed.contains_key(&path)
            && !app.notes.requested(&path)
        {
            app.notes
                .enqueue(Want::Read(path, Purpose::Prefetch), false);
        }
    }
}

fn keep_selection_visible(app: &mut App) {
    if app.notes.selected_index().is_none() {
        app.notes.selected = app.notes.visible().first().map(|s| s.path.clone());
        app.notes.preview_scroll = 0;
    }
}

fn edit_selected(app: &mut App) {
    if app
        .notes
        .draft
        .as_ref()
        .is_some_and(|draft| draft.dirty && !draft.saving)
    {
        app.notes.view = View::Edit;
        app.notice = "Resumed the unsaved note.".into();
        return;
    }
    let Some(path) = app.notes.selected.clone() else {
        app.notice = "No note selected; press n to write one.".into();
        return;
    };
    if app.notes.contents.contains_key(&path) {
        return begin_edit(app, &path);
    }
    app.notes.failed.remove(&path);
    app.notes
        .queue
        .retain(|want| !matches!(want, Want::Read(known, _) if *known == path));
    app.notes.enqueue(Want::Read(path, Purpose::Edit), true);
}

fn new_note(app: &mut App) {
    if app.notes.listing.is_none() {
        app.notice = "The notes folder is still loading.".into();
        return;
    }
    if app
        .notes
        .draft
        .as_ref()
        .is_some_and(|draft| draft.dirty && !draft.saving)
    {
        app.notes.view = View::Edit;
        app.notice = "Resumed the unsaved note.".into();
        return;
    }
    app.notes.draft = Some(Draft::default());
    app.notes.view = View::Edit;
}

fn copy(app: &mut App, outcome: &mut Outcome) {
    let Some(path) = app.notes.selected.clone() else {
        app.notice = "No note selected.".into();
        return;
    };
    match app.notes.contents.get(&path) {
        Some(loaded) => outcome.clipboard = Some(loaded.text.clone()),
        None => app.notice = "The note is still loading; press y again.".into(),
    }
}

fn paste_path(app: &mut App, outcome: &mut Outcome) {
    let Some(path) = app.notes.selected.clone() else {
        app.notice = "No note selected.".into();
        return;
    };
    if path.chars().any(char::is_control) {
        app.notice = "This path contains control characters; nothing was pasted.".into();
        return;
    }
    let Some(terminal) = app.active_terminal() else {
        app.notice = "Open a session to paste the note path into.".into();
        return;
    };
    let data = crate::input::encode_paste(&path, terminal.screen());
    if let Some(command) = app.input(data) {
        outcome.commands.push(command);
        app.notice = format!("Pasted {path}");
    }
}

fn escape(app: &mut App) {
    if leaf_index(app).is_some() {
        app.notes.focused = false;
    } else {
        close(app);
    }
}

pub fn event(app: &mut App, event: Event, area: Rect) -> Outcome {
    let mut outcome = Outcome::default();
    match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => {
            key_event(app, key, area, &mut outcome);
        }
        Event::Paste(text) if app.notes.view == View::Edit => {
            edit_text(app, &text, area);
        }
        Event::Paste(text) if app.notes.view == View::Search => {
            search_text(app, &text.replace(['\r', '\n'], " "));
        }
        Event::Resize(..) => {}
        _ => outcome.redraw = false,
    }
    outcome.commands.extend(sync(app));
    outcome
}

fn plain(key: &KeyEvent) -> bool {
    !key.modifiers
        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
}

fn page(app: &App, area: Rect) -> usize {
    crate::ui_notes::editor_height(app, area).max(1)
}

fn edit_text(app: &mut App, text: &str, area: Rect) {
    let height = page(app, area);
    let Some(draft) = app.notes.draft.as_mut() else {
        return;
    };
    if draft.editor.insert(text) {
        draft.dirty = true;
    } else {
        app.notice = "Notes are limited to 64 KiB.".into();
    }
    draft.editor.follow(height);
}

fn search_text(app: &mut App, text: &str) {
    let room = notes::MAX_QUERY_CHARS.saturating_sub(app.notes.query.chars().count());
    app.notes
        .query
        .extend(text.chars().filter(|c| !c.is_control()).take(room));
    keep_selection_visible(app);
}

fn key_event(app: &mut App, key: KeyEvent, area: Rect, outcome: &mut Outcome) {
    match app.notes.view {
        View::Edit => return edit_key(app, key, area),
        View::Search => return search_key(app, key),
        View::ConfirmDelete => return confirm_key(app, key),
        View::Browse => {}
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        if key.code == KeyCode::Char('c') {
            outcome.quit = true;
        } else {
            outcome.redraw = false;
        }
        return;
    }
    let preview = page(app, area);
    match key.code {
        KeyCode::Esc | KeyCode::Char('q') => escape(app),
        KeyCode::Down | KeyCode::Char('j') => move_selection(app, 1),
        KeyCode::Up | KeyCode::Char('k') => move_selection(app, -1),
        KeyCode::PageDown => app.notes.preview_scroll += preview,
        KeyCode::PageUp => {
            app.notes.preview_scroll = app.notes.preview_scroll.saturating_sub(preview);
        }
        KeyCode::Enter => edit_selected(app),
        KeyCode::Char('n') => new_note(app),
        KeyCode::Char('d') if app.notes.selected.is_some() => {
            app.notes.view = View::ConfirmDelete;
        }
        KeyCode::Char('/') => start_search(app),
        KeyCode::Char('y') => copy(app, outcome),
        KeyCode::Char('p') => paste_path(app, outcome),
        KeyCode::Char('r') => {
            app.notes.failed.clear();
            app.notes.refresh();
        }
        _ => outcome.redraw = false,
    }
}

fn search_key(app: &mut App, key: KeyEvent) {
    match key.code {
        KeyCode::Esc => {
            app.notes.query.clear();
            app.notes.view = View::Browse;
        }
        KeyCode::Enter => app.notes.view = View::Browse,
        KeyCode::Backspace => {
            app.notes.query.pop();
        }
        KeyCode::Down => move_selection(app, 1),
        KeyCode::Up => move_selection(app, -1),
        KeyCode::Char(c) if plain(&key) => search_text(app, &c.to_string()),
        _ => {}
    }
    keep_selection_visible(app);
}

fn confirm_key(app: &mut App, key: KeyEvent) {
    match key.code {
        KeyCode::Char('y') | KeyCode::Enter => {
            if let Some(path) = app.notes.selected.clone() {
                app.notes.enqueue(Want::Delete(path), true);
            }
            app.notes.view = View::Browse;
        }
        KeyCode::Char('n') | KeyCode::Esc => app.notes.view = View::Browse,
        _ => {}
    }
}

fn edit_key(app: &mut App, key: KeyEvent, area: Rect) {
    let control = key.modifiers.contains(KeyModifiers::CONTROL);
    if key.code == KeyCode::Esc {
        return leave_edit(app);
    }
    if (control && matches!(key.code, KeyCode::Char('s' | 'S')))
        || key.code == KeyCode::Char('\u{13}')
    {
        return save(app);
    }
    let height = page(app, area);
    let Some(draft) = app.notes.draft.as_mut() else {
        app.notes.view = View::Browse;
        return;
    };
    let editor = &mut draft.editor;
    let mut changed = false;
    match key.code {
        KeyCode::Char(c) if plain(&key) => {
            if editor.insert(&c.to_string()) {
                changed = true;
            } else {
                app.notice = "Notes are limited to 64 KiB.".into();
            }
        }
        KeyCode::Enter => changed = editor.insert("\n"),
        KeyCode::Tab => changed = editor.insert("\t"),
        KeyCode::Backspace => {
            editor.backspace();
            changed = true;
        }
        KeyCode::Delete => {
            editor.delete();
            changed = true;
        }
        KeyCode::Left => editor.left(),
        KeyCode::Right => editor.right(),
        KeyCode::Up => editor.vertical(-1),
        KeyCode::Down => editor.vertical(1),
        KeyCode::Home => editor.home(),
        KeyCode::End => editor.end(),
        KeyCode::PageUp => editor.vertical(-isize::try_from(height).unwrap_or(1)),
        KeyCode::PageDown => editor.vertical(isize::try_from(height).unwrap_or(1)),
        _ => {}
    }
    if changed {
        draft.dirty = draft
            .path
            .as_ref()
            .and_then(|path| app.notes.contents.get(path))
            .is_none_or(|loaded| loaded.text != draft.editor.text());
    }
    draft.editor.follow(height);
}

pub fn capture_key(app: &App, key: &KeyEvent) -> bool {
    key.kind != KeyEventKind::Release
        && (key.code == KeyCode::Char('\u{14}')
            || (key.modifiers.contains(KeyModifiers::CONTROL)
                && matches!(key.code, KeyCode::Char('t' | 'T'))))
        && app.mode == Mode::Navigate
        && app.dialog.is_none()
        && app.session_kind.is_none()
        && app.layout_picker.is_none()
        && app.overlay.is_none()
}

pub fn begin_capture(app: &mut App) {
    if !app.connected {
        app.notice = "Reconnect to the host before capturing a note.".into();
        return;
    }
    if !supported(app) {
        app.notice = "Update nesvo-host to use Notes.".into();
        return;
    }
    if project_root(app).is_none() {
        app.notice = "Open a session to capture a note for its project.".into();
        return;
    }
    if app.notes.job.is_some() {
        app.notice = "The previous quick note is still being saved.".into();
        return;
    }
    app.notes.capture = Some(CaptureInput {
        text: String::new(),
        date: chrono::Local::now().format("%Y-%m-%d").to_string(),
    });
}

pub fn submit_capture(app: &mut App, time: &str) -> Vec<Value> {
    let Some(input) = app.notes.capture.take() else {
        return Vec::new();
    };
    let Some(root) = project_root(app) else {
        return Vec::new();
    };
    let known = app
        .notes
        .listing
        .as_ref()
        .filter(|listing| listing.root == root)
        .map(|listing| notes::join(&listing.directory, &notes::today_name(&input.date)));
    app.notes.job = Some(CaptureJob {
        line: input.text.trim().to_owned(),
        root: root.clone(),
        date: input.date,
        time: time.to_owned(),
        attempts: 0,
        path: known.clone(),
    });
    match known {
        Some(path) => app.notes.enqueue(Want::Read(path, Purpose::Capture), true),
        None => app.notes.enqueue(Want::List(root), true),
    }
    sync(app)
}

pub fn capture_event(app: &mut App, event: Event) -> Outcome {
    let mut outcome = Outcome::default();
    let Some(input) = app.notes.capture.as_mut() else {
        return outcome;
    };
    let room = notes::MAX_CAPTURE_CHARS.saturating_sub(input.text.chars().count());
    match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => match key.code {
            KeyCode::Esc => app.notes.capture = None,
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                app.notes.capture = None;
            }
            KeyCode::Enter if notes::capture_text(&input.text) => {
                let time = chrono::Local::now().format("%H:%M").to_string();
                outcome.commands.extend(submit_capture(app, &time));
            }
            KeyCode::Backspace => {
                input.text.pop();
            }
            KeyCode::Char(c) if plain(&key) && room > 0 => input.text.push(c),
            _ => {}
        },
        Event::Paste(text) => input.text.extend(
            text.replace(['\r', '\n', '\t'], " ")
                .chars()
                .filter(|c| !c.is_control())
                .take(room),
        ),
        Event::Resize(..) => {}
        _ => outcome.redraw = false,
    }
    outcome
}

pub fn apply_layout(app: &mut App) -> Vec<Value> {
    if leaf_index(app).is_some() && supported(app) {
        open(app, false)
    } else {
        Vec::new()
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::controller;

    pub const PLAN: &str = "/w/.nesvo/notes/plan.md";
    pub const IDEAS: &str = "/w/.nesvo/notes/ideas.md";

    pub fn app() -> App {
        let mut app = App::new(1);
        app.event(json!({"type":"capabilities","workspace":"/w","programs":[],"notes":true}))
            .unwrap();
        app.event(
            json!({"type":"sessions","revision":1,"groups":[],"sessions":[
                {"id":"s","name":"agent","cwd":"/w","program":"claude","cols":80,"rows":24,
                 "running":true,"groupId":null,"controllerId":null}
            ]}),
        )
        .unwrap();
        app.connected = true;
        app.dialog = None;
        app.overlay = None;
        app.onboarded = true;
        app.notice.clear();
        app.panes[0] = Some("s".into());
        app
    }

    pub fn key(app: &mut App, code: KeyCode, modifiers: KeyModifiers) -> Outcome {
        controller::event(
            app,
            Event::Key(KeyEvent::new(code, modifiers)),
            Rect::new(0, 0, 100, 32),
        )
    }

    pub fn press(app: &mut App, code: KeyCode) -> Vec<Value> {
        key(app, code, KeyModifiers::NONE).commands
    }

    pub fn typed(app: &mut App, text: &str) {
        for c in text.chars() {
            assert!(press(app, KeyCode::Char(c)).is_empty());
        }
    }

    pub fn reply(app: &mut App, command: &Value, mut event: Value) -> Vec<Value> {
        event["requestId"] = command["requestId"].clone();
        app.event(event).unwrap()
    }

    fn only<'a>(commands: &'a [Value], kind: &str) -> &'a Value {
        let found: Vec<&Value> = commands.iter().filter(|c| c["type"] == kind).collect();
        assert_eq!(found.len(), 1, "{commands:?}");
        found[0]
    }

    pub fn listing() -> Value {
        json!({"type":"notes","root":"/w","directory":"/w/.nesvo/notes","location":"repository",
        "repository":"/w","truncated":false,"notes":[
            {"name":"plan.md","path":PLAN,"size":14,"modifiedMs":2,"firstLine":"# Plan"},
            {"name":"ideas.md","path":IDEAS,"size":12,"modifiedMs":1,"firstLine":"deploy later"}
        ]})
    }

    pub fn loaded() -> App {
        let mut app = app();
        let commands = press(&mut app, KeyCode::Char('T'));
        let list = only(&commands, "listNotes").clone();
        assert_eq!(list["root"], "/w");
        let follow = reply(&mut app, &list, listing());
        let read = only(&follow, "readNote").clone();
        assert_eq!(read["path"], PLAN);
        let follow = reply(
            &mut app,
            &read,
            json!({"type":"note","path":PLAN,"name":"plan.md","text":"# Plan\nship it",
                "size":14,"modifiedMs":2,"revision":"r1"}),
        );
        assert!(follow.is_empty());
        app
    }

    fn app_with_saved(saved: &Saved) -> App {
        let mut app = app();
        app.notes.restore(saved);
        app
    }

    #[test]
    fn notes_view_lists_the_project_previews_on_demand_and_remembers_the_open_note() {
        let mut app = loaded();
        assert!(app.notes.open && app.notes.focused);
        assert_eq!(app.notes.selected.as_deref(), Some(PLAN));
        let next = press(&mut app, KeyCode::Char('j'));
        assert_eq!(only(&next, "readNote")["path"], IDEAS);
        press(&mut app, KeyCode::Char('k'));
        assert!(press(&mut app, KeyCode::Enter).is_empty());
        assert_eq!(app.notes.view, View::Edit);
        assert_eq!(
            app.notes.saved().last,
            [LastNote {
                directory: "/w/.nesvo/notes".into(),
                name: "plan.md".into()
            }]
        );
        let mut restored = app_with_saved(&app.notes.saved());
        let commands = press(&mut restored, KeyCode::Char('T'));
        let mut listing = listing();
        let swapped = json!([listing["notes"][1].clone(), listing["notes"][0].clone()]);
        listing["notes"] = swapped;
        reply(&mut restored, only(&commands, "listNotes"), listing);
        assert_eq!(restored.notes.selected.as_deref(), Some(PLAN));
    }

    #[test]
    fn notes_unsupported_hosts_send_nothing_and_escape_closes_the_view() {
        let mut app = app();
        app.host_features = json!({"type":"capabilities"});
        assert!(press(&mut app, KeyCode::Char('T')).is_empty());
        assert!(app.notice.contains("Update nesvo-host"));
        assert!(!app.notes.open);
        let mut app = loaded();
        assert!(press(&mut app, KeyCode::Esc).is_empty());
        assert!(!app.notes.open);
        assert!(!captures(&app));
    }

    #[test]
    fn notes_editor_creates_a_note_named_from_its_first_line_and_saves_on_escape() {
        let mut app = loaded();
        press(&mut app, KeyCode::Char('n'));
        assert_eq!(app.notes.view, View::Edit);
        typed(&mut app, "# Release");
        assert!(press(&mut app, KeyCode::Enter).is_empty());
        typed(&mut app, "go");
        assert!(press(&mut app, KeyCode::Left).is_empty());
        press(&mut app, KeyCode::Backspace);
        let commands = press(&mut app, KeyCode::Esc);
        let write = only(&commands, "writeNote").clone();
        assert_eq!(
            write,
            json!({"type":"writeNote","path":"/w/.nesvo/notes/release.md","text":"# Release\no",
                "expectedRevision":null,"requestId":write["requestId"]})
        );
        assert_eq!(app.notes.view, View::Browse);
        let follow = reply(
            &mut app,
            &write,
            json!({"type":"noteSaved","path":"/w/.nesvo/notes/release.md","name":"release.md",
                "revision":"r2","size":11,"modifiedMs":3,"created":true}),
        );
        only(&follow, "listNotes");
        let draft = app.notes.draft.as_ref().unwrap();
        assert!(!draft.dirty);
        assert_eq!(draft.revision.as_deref(), Some("r2"));
        assert_eq!(
            app.notes.selected.as_deref(),
            Some("/w/.nesvo/notes/release.md")
        );
        assert_eq!(app.notice, "Saved release.md");
        press(&mut app, KeyCode::Char('n'));
        assert!(press(&mut app, KeyCode::Esc).is_empty());
        assert!(app.notes.draft.is_none());
    }

    #[test]
    fn notes_editor_sends_the_revision_and_keeps_text_on_a_stale_refusal() {
        let mut app = loaded();
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::End);
        typed(&mut app, "!");
        assert!(app.notes.draft.as_ref().unwrap().dirty);
        let commands = key(&mut app, KeyCode::Char('s'), KeyModifiers::CONTROL).commands;
        let write = only(&commands, "writeNote").clone();
        assert_eq!(write["expectedRevision"], "r1");
        assert_eq!(write["text"], "# Plan!\nship it");
        reply(
            &mut app,
            &write,
            json!({"type":"error","code":"stale_revision","message":"changed","revision":"r9"}),
        );
        let draft = app.notes.draft.as_ref().unwrap();
        assert_eq!(draft.conflict, Some(Some("r9".into())));
        assert!(draft.dirty);
        assert!(app.notice.contains("changed elsewhere"));
        assert_eq!(app.notes.view, View::Edit);
        assert!(press(&mut app, KeyCode::Esc).is_empty());
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.notes.view, View::Edit);
        let commands = key(&mut app, KeyCode::Char('s'), KeyModifiers::CONTROL).commands;
        assert_eq!(only(&commands, "writeNote")["expectedRevision"], "r9");
        let control = key(&mut app, KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert!(control.commands.is_empty() && !control.quit);
    }

    #[test]
    fn notes_delete_requires_confirmation_and_moves_the_selection() {
        let mut app = loaded();
        press(&mut app, KeyCode::Char('d'));
        assert_eq!(app.notes.view, View::ConfirmDelete);
        assert!(press(&mut app, KeyCode::Char('n')).is_empty());
        assert_eq!(app.notes.view, View::Browse);
        press(&mut app, KeyCode::Char('d'));
        let commands = press(&mut app, KeyCode::Char('y'));
        let delete = only(&commands, "deleteNote").clone();
        assert_eq!(delete["path"], PLAN);
        let follow = reply(
            &mut app,
            &delete,
            json!({"type":"noteDeleted","path":PLAN,"name":"plan.md"}),
        );
        only(&follow, "listNotes");
        assert_eq!(app.notes.selected.as_deref(), Some(IDEAS));
        assert_eq!(app.notice, "Deleted plan.md");
    }

    #[test]
    fn notes_search_prefetches_content_and_filters_first_lines_and_text() {
        let mut app = loaded();
        let commands = press(&mut app, KeyCode::Char('/'));
        assert_eq!(app.notes.view, View::Search);
        let prefetch = only(&commands, "readNote").clone();
        assert_eq!(prefetch["path"], IDEAS);
        reply(
            &mut app,
            &prefetch,
            json!({"type":"note","path":IDEAS,"name":"ideas.md","text":"deploy later\nrollback plan",
                "size":12,"modifiedMs":1,"revision":"i1"}),
        );
        typed(&mut app, "ship");
        let names: Vec<_> = app.notes.visible().iter().map(|s| s.name.clone()).collect();
        assert_eq!(names, ["plan.md"]);
        for _ in 0..4 {
            press(&mut app, KeyCode::Backspace);
        }
        typed(&mut app, "rollback");
        assert_eq!(app.notes.selected.as_deref(), Some(IDEAS));
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.notes.view, View::Browse);
        assert_eq!(app.notes.query, "rollback");
        press(&mut app, KeyCode::Char('/'));
        press(&mut app, KeyCode::Esc);
        assert!(app.notes.query.is_empty());
        assert_eq!(app.notes.visible().len(), 2);
    }

    #[test]
    fn notes_copy_and_paste_path_use_the_selected_note() {
        let mut app = loaded();
        let outcome = key(&mut app, KeyCode::Char('y'), KeyModifiers::NONE);
        assert_eq!(outcome.clipboard.as_deref(), Some("# Plan\nship it"));
        assert!(press(&mut app, KeyCode::Char('p')).is_empty());
        assert!(!app.notice.is_empty());
        app.event(json!({"type":"subscribed","sessionId":"s","cols":80,"rows":24}))
            .unwrap();
        app.activate_session("s");
        app.event(json!({"type":"control","sessionId":"s","controllerId":1,"cols":80,"rows":24,"leaseId":"own"}))
            .unwrap();
        app.mode = Mode::Navigate;
        app.notes.focused = true;
        let commands = press(&mut app, KeyCode::Char('p'));
        let input = only(&commands, "input");
        assert!(input["data"].as_str().unwrap().contains(PLAN));
        assert_eq!(input["leaseId"], "own");
    }

    #[test]
    fn notes_quick_capture_creates_then_appends_to_todays_note_with_revisions() {
        let mut app = loaded();
        press(&mut app, KeyCode::Esc);
        app.mode = Mode::Input;
        assert!(!capture_key(
            &app,
            &KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL)
        ));
        app.mode = Mode::Navigate;
        let opened = key(&mut app, KeyCode::Char('t'), KeyModifiers::CONTROL);
        assert!(opened.commands.is_empty());
        let date = app.notes.capture.as_ref().unwrap().date.clone();
        typed(&mut app, "idea");
        app.notes.capture.as_mut().unwrap().text.push_str(" one");
        let today = format!("/w/.nesvo/notes/{date}.md");
        let commands = press(&mut app, KeyCode::Enter);
        assert!(app.notes.capture.is_none());
        let read = only(&commands, "readNote").clone();
        assert_eq!(read["path"], today.as_str());
        let follow = reply(
            &mut app,
            &read,
            json!({"type":"error","code":"not_found","message":"missing"}),
        );
        let write = only(&follow, "writeNote").clone();
        let text = write["text"].as_str().unwrap();
        assert!(text.starts_with(&format!("# {date}\n\n- ")), "{text}");
        assert!(text.ends_with(" idea one\n"), "{text}");
        assert_eq!(write["expectedRevision"], Value::Null);
        reply(
            &mut app,
            &write,
            json!({"type":"noteSaved","path":today,"name":format!("{date}.md"),"revision":"c1",
                "size":30,"modifiedMs":9,"created":true}),
        );
        assert_eq!(app.notice, format!("Captured to {date}.md"));
        app.notes.capture = Some(CaptureInput {
            text: "two".into(),
            date: date.clone(),
        });
        app.notes.contents.remove(&today);
        let commands = submit_capture(&mut app, "09:07");
        let read = only(&commands, "readNote").clone();
        let follow = reply(
            &mut app,
            &read,
            json!({"type":"note","path":today,"name":"t.md","text":"# d\n\n- 09:05 idea","size":18,
                "modifiedMs":9,"revision":"c1"}),
        );
        let write = only(&follow, "writeNote").clone();
        assert_eq!(write["text"], "# d\n\n- 09:05 idea\n- 09:07 two\n");
        assert_eq!(write["expectedRevision"], "c1");
        let follow = reply(
            &mut app,
            &write,
            json!({"type":"error","code":"stale_revision","message":"changed","revision":"c2"}),
        );
        assert_eq!(only(&follow, "readNote")["path"], today.as_str());
    }

    #[test]
    fn notes_disconnect_drops_pending_requests_and_relists_after_reconnect() {
        let mut app = loaded();
        assert!(!press(&mut app, KeyCode::Char('r')).is_empty());
        app.disconnect("gone".into());
        assert!(!app.notes.loading());
        app.connected = true;
        let commands = sync(&mut app);
        assert_eq!(only(&commands, "listNotes")["root"], "/w");
    }
}
