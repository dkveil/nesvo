use crate::{launch::Program, model::App};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::{Constraint, Layout, Rect};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

pub const MAX_LEAVES: usize = 4;
pub const MAX_PROJECTS: usize = 32;
pub const MAX_PROJECT_LAYOUTS: usize = 8;
pub const MAX_HOST_LAYOUTS: usize = 16;
pub const MAX_NAME_CHARS: usize = 40;
pub const LIBRARY_BYTES: usize = 48 * 1024;
pub const SIDEBAR_SESSIONS: &str = "sessions";
const MAX_PROJECT_KEY_BYTES: usize = 128;
const QUAD_COLUMNS: u16 = 150;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Agent,
    Terminal,
    Review,
    Files,
    Jobs,
    Overview,
    Empty,
}

impl Role {
    pub fn hosts_session(self) -> bool {
        matches!(self, Self::Agent | Self::Terminal | Self::Empty)
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Agent => "Agent",
            Self::Terminal => "Terminal",
            Self::Review => "Review",
            Self::Files => "Files",
            Self::Jobs => "Jobs",
            Self::Overview => "Overview",
            Self::Empty => "Empty",
        }
    }

    pub fn view_hint(self, review_key: u8) -> String {
        match self {
            Self::Review => format!("Press F{review_key} to review the active session's changes"),
            Self::Files => "Press 2 to browse files".into(),
            Self::Jobs => "Press J to open Jobs".into(),
            Self::Overview => "Press O to focus the session overview".into(),
            Self::Agent | Self::Terminal | Self::Empty => "Press n to start a session".into(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Horizontal,
    Vertical,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Slot {
    pub role: Role,
    pub provider: Option<Program>,
}

impl Slot {
    pub fn label(self) -> String {
        match (self.role, self.provider) {
            (Role::Agent, Some(program)) => program.label().to_owned(),
            (role, _) => role.label().to_owned(),
        }
    }
}

fn half() -> u16 {
    50
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PaneTree {
    Leaf {
        role: Role,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<Program>,
    },
    Split {
        direction: Direction,
        #[serde(default = "half")]
        ratio: u16,
        first: Box<PaneTree>,
        second: Box<PaneTree>,
    },
}

impl PaneTree {
    pub fn leaf(role: Role) -> Self {
        Self::Leaf {
            role,
            provider: None,
        }
    }

    pub fn split(direction: Direction, first: Self, second: Self) -> Self {
        Self::Split {
            direction,
            ratio: half(),
            first: Box::new(first),
            second: Box::new(second),
        }
    }

    pub fn single() -> Self {
        Self::leaf(Role::Empty)
    }

    pub fn classic() -> Self {
        Self::split(
            Direction::Horizontal,
            Self::leaf(Role::Empty),
            Self::leaf(Role::Empty),
        )
    }

    pub fn leaf_count(&self) -> usize {
        match self {
            Self::Leaf { .. } => 1,
            Self::Split { first, second, .. } => first.leaf_count() + second.leaf_count(),
        }
    }

    pub fn valid(&self) -> bool {
        self.leaf_count() <= MAX_LEAVES
    }

    pub fn slots(&self) -> Vec<Slot> {
        let mut slots = Vec::new();
        self.collect(&mut slots);
        slots
    }

    fn collect(&self, slots: &mut Vec<Slot>) {
        match self {
            Self::Leaf { role, provider } => slots.push(Slot {
                role: *role,
                provider: *provider,
            }),
            Self::Split { first, second, .. } => {
                first.collect(slots);
                second.collect(slots);
            }
        }
    }

    pub fn position(&self, role: Role) -> Option<usize> {
        self.slots().iter().position(|slot| slot.role == role)
    }

    pub fn with_slots(&self, slots: &[Slot]) -> Self {
        let mut tree = self.clone();
        let mut index = 0;
        tree.replace(slots, &mut index);
        tree
    }

    fn replace(&mut self, slots: &[Slot], index: &mut usize) {
        match self {
            Self::Leaf { role, provider } => {
                if let Some(slot) = slots.get(*index) {
                    *role = slot.role;
                    *provider = slot.provider;
                }
                *index += 1;
            }
            Self::Split { first, second, .. } => {
                first.replace(slots, index);
                second.replace(slots, index);
            }
        }
    }

    pub fn areas(&self, area: Rect) -> [Rect; MAX_LEAVES] {
        let mut areas = [Rect::default(); MAX_LEAVES];
        let mut index = 0;
        self.place(area, &mut index, &mut areas);
        areas
    }

    fn place(&self, area: Rect, index: &mut usize, areas: &mut [Rect; MAX_LEAVES]) {
        match self {
            Self::Leaf { .. } => {
                if let Some(slot) = areas.get_mut(*index) {
                    *slot = area;
                }
                *index += 1;
            }
            Self::Split {
                direction,
                ratio,
                first,
                second,
            } => {
                let ratio = (*ratio).clamp(20, 80);
                let constraints = [
                    Constraint::Percentage(ratio),
                    Constraint::Percentage(100 - ratio),
                ];
                let side_by_side = match direction {
                    Direction::Horizontal => area.width >= 40,
                    Direction::Vertical => area.height < 8 && area.width >= 40,
                };
                let [left, right] = if side_by_side {
                    Layout::horizontal(constraints).areas(area)
                } else {
                    Layout::vertical(constraints).areas(area)
                };
                first.place(left, index, areas);
                second.place(right, index, areas);
            }
        }
    }

    pub fn summary(&self) -> String {
        self.slots()
            .iter()
            .map(|slot| slot.label())
            .collect::<Vec<_>>()
            .join(" · ")
    }
}

fn sessions_mode() -> String {
    SIDEBAR_SESSIONS.into()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedLayout {
    pub name: String,
    pub tree: PaneTree,
    #[serde(default = "sessions_mode")]
    pub sidebar_mode: String,
    #[serde(default)]
    pub sidebar_width: u16,
    #[serde(default)]
    pub min_columns: u16,
}

impl NamedLayout {
    fn new(name: &str, tree: PaneTree) -> Self {
        Self {
            name: name.into(),
            tree,
            sidebar_mode: sessions_mode(),
            sidebar_width: 0,
            min_columns: 0,
        }
    }

    fn valid(&self) -> bool {
        valid_name(&self.name)
            && self.tree.valid()
            && self.sidebar_mode.len() <= 16
            && !self.sidebar_mode.chars().any(char::is_control)
    }
}

pub fn valid_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && trimmed == name
        && name.chars().count() <= MAX_NAME_CHARS
        && !name.chars().any(char::is_control)
}

fn valid_project_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= MAX_PROJECT_KEY_BYTES && !key.chars().any(char::is_control)
}

pub fn shipped() -> Vec<NamedLayout> {
    let agent = || PaneTree::leaf(Role::Agent);
    let pair = |role| PaneTree::split(Direction::Horizontal, agent(), PaneTree::leaf(role));
    let mut quad = NamedLayout::new(
        "Quad",
        PaneTree::split(
            Direction::Vertical,
            PaneTree::split(Direction::Horizontal, agent(), agent()),
            PaneTree::split(
                Direction::Horizontal,
                PaneTree::leaf(Role::Terminal),
                PaneTree::leaf(Role::Review),
            ),
        ),
    );
    quad.min_columns = QUAD_COLUMNS;
    vec![
        NamedLayout::new("Agent + Terminal", pair(Role::Terminal)),
        NamedLayout::new("Agent + Review", pair(Role::Review)),
        NamedLayout::new("Agent + Files", pair(Role::Files)),
        quad,
    ]
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Scope {
    pub layouts: Vec<NamedLayout>,
    pub active: Option<String>,
    pub default: Option<String>,
    pub used: u64,
}

impl Scope {
    fn sanitize(&mut self, limit: usize) {
        let mut seen = HashSet::new();
        let shipped: HashSet<_> = shipped().into_iter().map(|layout| layout.name).collect();
        self.layouts.retain(|layout| {
            layout.valid() && !shipped.contains(&layout.name) && seen.insert(layout.name.clone())
        });
        self.layouts.truncate(limit);
        let known = |name: &String| shipped.contains(name) || seen.contains(name);
        self.active = self.active.take().filter(known);
        self.default = self.default.take().filter(known);
    }

    fn position(&self, name: &str) -> Option<usize> {
        self.layouts.iter().position(|layout| layout.name == name)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    Shipped,
    Project,
    Host,
}

impl Origin {
    pub fn label(self) -> &'static str {
        match self {
            Self::Shipped => "shipped",
            Self::Project => "project",
            Self::Host => "host",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub layout: NamedLayout,
    pub origin: Origin,
    pub active: bool,
    pub default: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Library {
    pub host: Scope,
    pub projects: BTreeMap<String, Scope>,
    pub clock: u64,
}

impl Library {
    pub fn sanitized(mut self) -> Self {
        self.host.sanitize(MAX_HOST_LAYOUTS);
        self.projects.retain(|key, _| valid_project_key(key));
        for scope in self.projects.values_mut() {
            scope.sanitize(MAX_PROJECT_LAYOUTS);
        }
        self.clock = self
            .projects
            .values()
            .map(|scope| scope.used)
            .max()
            .unwrap_or(0)
            .max(self.clock);
        self.enforce_bounds();
        self
    }

    fn enforce_bounds(&mut self) {
        while self.projects.len() > MAX_PROJECTS
            || (!self.projects.is_empty()
                && serde_json::to_vec(self).map_or(0, |bytes| bytes.len()) > LIBRARY_BYTES)
        {
            let Some(oldest) = self
                .projects
                .iter()
                .min_by_key(|(key, scope)| (scope.used, (*key).clone()))
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.projects.remove(&oldest);
        }
    }

    fn scope(&self, project: Option<&str>) -> Option<&Scope> {
        match project {
            Some(key) => self.projects.get(key),
            None => Some(&self.host),
        }
    }

    fn scope_mut(&mut self, project: Option<&str>) -> &mut Scope {
        match project.filter(|key| valid_project_key(key)) {
            Some(key) => {
                self.clock += 1;
                let clock = self.clock;
                let scope = self.projects.entry(key.to_owned()).or_default();
                scope.used = clock;
                scope
            }
            None => &mut self.host,
        }
    }

    fn limit(project: Option<&str>) -> usize {
        if project.is_some() {
            MAX_PROJECT_LAYOUTS
        } else {
            MAX_HOST_LAYOUTS
        }
    }

    pub fn entries(&self, project: Option<&str>) -> Vec<Entry> {
        let current = self.scope(project);
        let marks = |name: &str| {
            (
                current.is_some_and(|scope| scope.active.as_deref() == Some(name)),
                current.is_some_and(|scope| scope.default.as_deref() == Some(name)),
            )
        };
        let mut entries = Vec::new();
        let mut push = |layout: &NamedLayout, origin| {
            let (active, default) = marks(&layout.name);
            entries.push(Entry {
                layout: layout.clone(),
                origin,
                active,
                default,
            });
        };
        for layout in &shipped() {
            push(layout, Origin::Shipped);
        }
        if let Some(scope) = project.and_then(|key| self.projects.get(key)) {
            for layout in &scope.layouts {
                push(layout, Origin::Project);
            }
        }
        for layout in &self.host.layouts {
            push(layout, Origin::Host);
        }
        entries
    }

    fn scope_of(origin: Origin, project: Option<&str>) -> Option<&str> {
        match origin {
            Origin::Project => project,
            Origin::Host | Origin::Shipped => None,
        }
    }

    pub fn save(&mut self, project: Option<&str>, layout: NamedLayout) -> Result<(), String> {
        if !valid_name(&layout.name) {
            return Err(format!(
                "Use a name of 1-{MAX_NAME_CHARS} characters without control characters."
            ));
        }
        if self
            .entries(project)
            .iter()
            .any(|entry| entry.layout.name == layout.name)
        {
            return Err(format!("A layout named {} already exists.", layout.name));
        }
        let project = project.filter(|key| valid_project_key(key));
        let limit = Self::limit(project);
        let scope = self.scope_mut(project);
        if scope.layouts.len() >= limit {
            return Err(format!("Delete a layout first; the limit is {limit}."));
        }
        scope.active = Some(layout.name.clone());
        scope.layouts.push(layout);
        self.enforce_bounds();
        Ok(())
    }

    pub fn rename(
        &mut self,
        project: Option<&str>,
        entry: &Entry,
        name: &str,
    ) -> Result<(), String> {
        if entry.origin == Origin::Shipped {
            return Err("Shipped layouts cannot be renamed.".into());
        }
        if !valid_name(name) {
            return Err(format!(
                "Use a name of 1-{MAX_NAME_CHARS} characters without control characters."
            ));
        }
        if name != entry.layout.name
            && self
                .entries(project)
                .iter()
                .any(|other| other.layout.name == name)
        {
            return Err(format!("A layout named {name} already exists."));
        }
        let scope = self.scope_mut(Self::scope_of(entry.origin, project));
        let Some(index) = scope.position(&entry.layout.name) else {
            return Err("That layout no longer exists.".into());
        };
        scope.layouts[index].name = name.into();
        for mark in [&mut scope.active, &mut scope.default] {
            if mark.as_deref() == Some(entry.layout.name.as_str()) {
                *mark = Some(name.into());
            }
        }
        self.enforce_bounds();
        Ok(())
    }

    pub fn delete(&mut self, project: Option<&str>, entry: &Entry) -> Result<(), String> {
        if entry.origin == Origin::Shipped {
            return Err("Shipped layouts cannot be deleted.".into());
        }
        let scope = self.scope_mut(Self::scope_of(entry.origin, project));
        let Some(index) = scope.position(&entry.layout.name) else {
            return Err("That layout no longer exists.".into());
        };
        scope.layouts.remove(index);
        for mark in [&mut scope.active, &mut scope.default] {
            if mark.as_deref() == Some(entry.layout.name.as_str()) {
                *mark = None;
            }
        }
        Ok(())
    }

    pub fn toggle_default(&mut self, project: Option<&str>, name: &str) -> bool {
        let scope = self.scope_mut(project);
        let enabled = scope.default.as_deref() != Some(name);
        scope.default = enabled.then(|| name.to_owned());
        self.enforce_bounds();
        enabled
    }

    pub fn mark_active(&mut self, project: Option<&str>, name: &str) {
        self.scope_mut(project).active = Some(name.to_owned());
        self.enforce_bounds();
    }

    pub fn startup_layout(&self, project: Option<&str>) -> Option<NamedLayout> {
        let default = self.default_layout(project)?;
        let active = self
            .scope(project)
            .and_then(|scope| scope.active.as_deref());
        (active != Some(default.name.as_str())).then_some(default)
    }

    pub fn default_layout(&self, project: Option<&str>) -> Option<NamedLayout> {
        let name = project
            .and_then(|key| self.projects.get(key))
            .and_then(|scope| scope.default.clone())
            .or_else(|| self.host.default.clone())?;
        self.entries(project)
            .into_iter()
            .find(|entry| entry.layout.name == name)
            .map(|entry| entry.layout)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    pub program: Program,
    pub running: bool,
}

pub fn assign(slots: &[Slot], candidates: &[Candidate]) -> [Option<String>; MAX_LEAVES] {
    let mut assigned: [Option<String>; MAX_LEAVES] = Default::default();
    let mut used = HashSet::new();
    for (index, slot) in slots.iter().enumerate().take(MAX_LEAVES) {
        let found = candidates.iter().find(|candidate| {
            candidate.running
                && !used.contains(&candidate.id)
                && match slot.role {
                    Role::Agent => {
                        candidate.program != Program::Shell
                            && slot
                                .provider
                                .is_none_or(|provider| provider == candidate.program)
                    }
                    Role::Terminal => candidate.program == Program::Shell,
                    _ => false,
                }
        });
        if let Some(candidate) = found {
            used.insert(candidate.id.clone());
            assigned[index] = Some(candidate.id.clone());
        }
    }
    assigned
}

pub fn apply(app: &mut App, layout: &NamedLayout, width: u16) -> Result<Vec<Value>, String> {
    if !layout.tree.valid() {
        return Err("This layout has more than four panes.".into());
    }
    if width < layout.min_columns {
        return Err(format!(
            "{} needs a terminal at least {} columns wide.",
            layout.name, layout.min_columns
        ));
    }
    let project = app.project_key();
    let assigned = assign(&layout.tree.slots(), &app.layout_candidates());
    app.set_pane_layout(layout.tree.clone());
    app.sidebar_width = layout.sidebar_width;
    crate::files_controller::apply_layout(app, &layout.sidebar_mode);
    let mut commands = Vec::new();
    for (index, id) in assigned.iter().enumerate() {
        if let Some(id) = id {
            app.focused = index;
            commands.extend(app.open_session(id));
        }
    }
    commands.extend(app.drop_hidden_subscriptions());
    let slots = layout.tree.slots();
    app.focused = (0..slots.len())
        .find(|index| slots[*index].role == Role::Agent && assigned[*index].is_some())
        .or_else(|| (0..slots.len()).find(|index| assigned[*index].is_some()))
        .or_else(|| slots.iter().position(|slot| slot.role.hosts_session()))
        .unwrap_or(0);
    app.mode = crate::model::Mode::Navigate;
    if layout.tree.position(Role::Review).is_some() && app.active_id().is_some() {
        app.review.return_to_input = false;
        app.review.focused = false;
        commands.extend(app.request_diff());
    }
    app.layouts.mark_active(project.as_deref(), &layout.name);
    Ok(commands)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Naming {
    pub value: String,
    pub renaming: Option<usize>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Picker {
    pub selected: usize,
    pub naming: Option<Naming>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Intent {
    Apply(usize),
    Save(String),
    Rename(usize, String),
    Delete(usize),
    ToggleDefault(usize),
    Close,
}

impl Picker {
    pub fn key(&mut self, key: KeyEvent, entries: &[Entry]) -> Option<Intent> {
        if self.naming.is_some() {
            return self.naming_key(key);
        }
        self.message = None;
        let count = entries.len();
        let selected = entries.get(self.selected);
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => Some(Intent::Close),
            KeyCode::Up | KeyCode::Char('k') => {
                self.selected = self.selected.saturating_sub(1);
                None
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.selected = (self.selected + 1).min(count.saturating_sub(1));
                None
            }
            KeyCode::Enter => selected.map(|_| Intent::Apply(self.selected)),
            KeyCode::Char('s') => {
                self.naming = Some(Naming {
                    value: next_name(entries),
                    renaming: None,
                });
                None
            }
            KeyCode::Char('r') => {
                match selected {
                    Some(entry) if entry.origin == Origin::Shipped => {
                        self.message = Some("Shipped layouts cannot be renamed.".into());
                    }
                    Some(entry) => {
                        self.naming = Some(Naming {
                            value: entry.layout.name.clone(),
                            renaming: Some(self.selected),
                        });
                    }
                    None => {}
                }
                None
            }
            KeyCode::Char('d') => match selected {
                Some(entry) if entry.origin == Origin::Shipped => {
                    self.message = Some("Shipped layouts cannot be deleted.".into());
                    None
                }
                Some(_) => Some(Intent::Delete(self.selected)),
                None => None,
            },
            KeyCode::Char('D') => selected.map(|_| Intent::ToggleDefault(self.selected)),
            _ => None,
        }
    }

    fn naming_key(&mut self, key: KeyEvent) -> Option<Intent> {
        let naming = self.naming.as_mut()?;
        match key.code {
            KeyCode::Esc => {
                self.naming = None;
                None
            }
            KeyCode::Enter => {
                let value = naming.value.trim().to_owned();
                if value.is_empty() {
                    self.message = Some("Enter a name for the layout.".into());
                    return None;
                }
                let renaming = naming.renaming;
                self.naming = None;
                Some(match renaming {
                    Some(index) => Intent::Rename(index, value),
                    None => Intent::Save(value),
                })
            }
            KeyCode::Backspace => {
                naming.value.pop();
                None
            }
            KeyCode::Char(character)
                if !key.modifiers.contains(KeyModifiers::CONTROL) && !character.is_control() =>
            {
                if naming.value.chars().count() < MAX_NAME_CHARS {
                    naming.value.push(character);
                }
                None
            }
            _ => None,
        }
    }

    pub fn paste(&mut self, text: &str) {
        if let Some(naming) = &mut self.naming {
            let room = MAX_NAME_CHARS.saturating_sub(naming.value.chars().count());
            naming
                .value
                .extend(text.chars().filter(|c| !c.is_control()).take(room));
        }
    }
}

fn next_name(entries: &[Entry]) -> String {
    (1..)
        .map(|number| format!("Layout {number}"))
        .find(|name| !entries.iter().any(|entry| &entry.layout.name == name))
        .unwrap_or_default()
}

pub fn open(app: &mut App) {
    let entries = app.layouts.entries(app.project_key().as_deref());
    let selected = entries
        .iter()
        .position(|entry| entry.active)
        .or_else(|| entries.iter().position(|entry| entry.default))
        .unwrap_or(0);
    app.dialog = None;
    app.dialog_button = None;
    app.layout_picker = Some(Picker {
        selected,
        ..Default::default()
    });
}

pub fn paste(app: &mut App, text: &str) {
    if let Some(picker) = &mut app.layout_picker {
        picker.paste(text);
    }
}

pub fn key(app: &mut App, key: KeyEvent, width: u16) -> Vec<Value> {
    let Some(mut picker) = app.layout_picker.take() else {
        return Vec::new();
    };
    let project = app.project_key();
    let entries = app.layouts.entries(project.as_deref());
    let Some(intent) = picker.key(key, &entries) else {
        app.layout_picker = Some(picker);
        return Vec::new();
    };
    let project = project.as_deref();
    let outcome = match intent {
        Intent::Close => return Vec::new(),
        Intent::Apply(index) => match apply(app, &entries[index].layout, width) {
            Ok(commands) => {
                app.notice = format!("Layout {} applied.", entries[index].layout.name);
                return commands;
            }
            Err(error) => Err(error),
        },
        Intent::Save(name) => {
            let layout = app.current_layout(&name);
            app.layouts.save(project, layout).map(|()| {
                picker.selected = app
                    .layouts
                    .entries(project)
                    .iter()
                    .position(|entry| entry.layout.name == name)
                    .unwrap_or(picker.selected);
                format!("Saved layout {name}.")
            })
        }
        Intent::Rename(index, name) => app
            .layouts
            .rename(project, &entries[index], &name)
            .map(|()| format!("Renamed to {name}.")),
        Intent::Delete(index) => app.layouts.delete(project, &entries[index]).map(|()| {
            picker.selected = picker
                .selected
                .min(app.layouts.entries(project).len().saturating_sub(1));
            format!("Deleted {}.", entries[index].layout.name)
        }),
        Intent::ToggleDefault(index) => {
            let name = &entries[index].layout.name;
            Ok(if app.layouts.toggle_default(project, name) {
                format!(
                    "{name} is now the {} default.",
                    if project.is_some() { "project" } else { "host" }
                )
            } else {
                format!("{name} is no longer the default.")
            })
        }
    };
    picker.message = Some(match outcome {
        Ok(message) | Err(message) => message,
    });
    app.layout_picker = Some(picker);
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session(id: &str, program: &str, running: bool) -> Value {
        json!({"id":id,"name":id,"cwd":"/work","program":program,"cols":80,"rows":24,
            "running":running,"groupId":null,"controllerId":null,
            "repositoryContext":{"source":"launchDirectory","state":"ready","name":"nesvo",
                "branch":"main","observedAt":1,"revision":1}})
    }

    fn app(sessions: Vec<Value>) -> App {
        let mut app = App::new(7);
        app.event(json!({"type":"capabilities","workspace":"/work","gitDiff":true,"programs":[]}))
            .unwrap();
        app.event(json!({"type":"sessions","revision":1,"groups":[],"sessions":sessions}))
            .unwrap();
        app
    }

    fn press(app: &mut App, code: KeyCode, width: u16) -> Vec<Value> {
        key(app, KeyEvent::new(code, KeyModifiers::NONE), width)
    }

    fn type_text(app: &mut App, text: &str) {
        for character in text.chars() {
            press(app, KeyCode::Char(character), 150);
        }
    }

    fn named(name: &str) -> NamedLayout {
        NamedLayout::new(
            name,
            PaneTree::split(
                Direction::Vertical,
                PaneTree::leaf(Role::Agent),
                PaneTree::leaf(Role::Terminal),
            ),
        )
    }

    #[test]
    fn layouts_split_tree_geometry_fits_each_terminal_size() {
        let quad = shipped().pop().unwrap().tree;
        for (width, height) in [(48u16, 22u16), (58, 30), (108, 42)] {
            let area = Rect::new(32, 1, width, height);
            let areas = quad.areas(area);
            assert!(areas.iter().all(|leaf| !leaf.is_empty()));
            assert!(areas.iter().all(|leaf| area.contains(leaf.as_position())));
            let total: u32 = areas
                .iter()
                .map(|leaf| u32::from(leaf.width) * u32::from(leaf.height))
                .sum();
            assert_eq!(total, u32::from(width) * u32::from(height));
            for (index, leaf) in areas.iter().enumerate() {
                for other in &areas[index + 1..] {
                    assert!(!leaf.intersects(*other));
                }
            }
        }
        let classic = PaneTree::classic().areas(Rect::new(0, 0, 100, 30));
        assert_eq!(classic[0], Rect::new(0, 0, 50, 30));
        assert_eq!(classic[1], Rect::new(50, 0, 50, 30));
        let narrow = PaneTree::classic().areas(Rect::new(0, 0, 30, 20));
        assert_eq!(narrow[0], Rect::new(0, 0, 30, 10));
        assert_eq!(narrow[1], Rect::new(0, 10, 30, 10));
        assert_eq!(quad.leaf_count(), 4);
        assert_eq!(quad.summary(), "Agent · Agent · Terminal · Review");
    }

    #[test]
    fn layouts_trees_with_more_than_four_leaves_are_invalid() {
        let five = PaneTree::split(
            Direction::Horizontal,
            PaneTree::classic(),
            PaneTree::split(Direction::Vertical, PaneTree::classic(), PaneTree::single()),
        );
        assert_eq!(five.leaf_count(), 5);
        assert!(!five.valid());
        let mut app = app(vec![]);
        let layout = NamedLayout::new("Five", five);
        assert!(apply(&mut app, &layout, 200).is_err());
    }

    #[test]
    fn layouts_role_matching_prefers_recent_running_sessions_of_the_role() {
        let candidates = [
            Candidate {
                id: "old-exited".into(),
                program: Program::Claude,
                running: false,
            },
            Candidate {
                id: "codex".into(),
                program: Program::Codex,
                running: true,
            },
            Candidate {
                id: "claude".into(),
                program: Program::Claude,
                running: true,
            },
            Candidate {
                id: "shell".into(),
                program: Program::Shell,
                running: true,
            },
        ];
        let slots = [
            Slot {
                role: Role::Agent,
                provider: Some(Program::Claude),
            },
            Slot {
                role: Role::Agent,
                provider: None,
            },
            Slot {
                role: Role::Terminal,
                provider: None,
            },
            Slot {
                role: Role::Agent,
                provider: None,
            },
        ];
        assert_eq!(
            assign(&slots, &candidates),
            [
                Some("claude".into()),
                Some("codex".into()),
                Some("shell".into()),
                None
            ]
        );
        let views = [
            Slot {
                role: Role::Review,
                provider: None,
            },
            Slot {
                role: Role::Files,
                provider: None,
            },
        ];
        assert_eq!(assign(&views, &candidates), [None, None, None, None]);
    }

    #[test]
    fn layouts_apply_fills_roles_and_never_acquires_control() {
        let mut app = app(vec![
            session("shell", "shell", true),
            session("claude", "claude", true),
            session("codex", "codex", true),
        ]);
        app.recent_sessions = vec!["codex".into(), "shell".into()];
        let layouts = shipped();
        let commands = apply(&mut app, &layouts[0], 120).unwrap();
        assert_eq!(app.panes[0].as_deref(), Some("codex"));
        assert_eq!(app.panes[1].as_deref(), Some("shell"));
        assert_eq!(app.focused, 0);
        assert!(app.split);
        assert!(app.mode == crate::model::Mode::Navigate);
        assert!(commands.iter().all(|command| matches!(
            command["type"].as_str(),
            Some("subscribe" | "unsubscribe" | "releaseControl" | "getDiff")
        )));
        let review = apply(&mut app, &layouts[1], 120).unwrap();
        assert!(review.iter().any(|command| command["type"] == "getDiff"));
        assert!(app.review.visible && !app.review.focused);
        assert_eq!(app.panes[1], None);
        assert!(
            review
                .iter()
                .any(|command| command["type"] == "unsubscribe" && command["sessionId"] == "shell")
        );
        assert!(
            review
                .iter()
                .all(|command| command["type"] != "acquireControl")
        );
        assert_eq!(app.active_id(), Some("codex"));
        assert!(
            app.layouts.entries(Some("nesvo"))[1].active,
            "Applied layout is the active one of the session's project"
        );
    }

    #[test]
    fn layouts_quad_needs_wide_terminals_and_unmatched_leaves_stay_empty() {
        let mut app = app(vec![session("claude", "claude", true)]);
        let quad = shipped().pop().unwrap();
        app.layout_picker = Some(Picker {
            selected: 3,
            ..Default::default()
        });
        assert!(press(&mut app, KeyCode::Enter, 100).is_empty());
        assert!(
            app.layout_picker
                .as_ref()
                .and_then(|picker| picker.message.as_deref())
                .is_some_and(|message| message.contains("150 columns"))
        );
        let commands = apply(&mut app, &quad, 150).unwrap();
        assert!(
            commands
                .iter()
                .all(|command| command["type"] != "acquireControl")
        );
        assert_eq!(app.leaf_count(), 4);
        assert_eq!(app.panes[0].as_deref(), Some("claude"));
        assert!(app.panes[1..].iter().all(Option::is_none));
    }

    #[test]
    fn layouts_dialog_saves_renames_sets_default_and_deletes_in_the_project_scope() {
        let mut app = app(vec![
            session("claude", "claude", true),
            session("shell", "shell", true),
        ]);
        apply(&mut app, &shipped()[0], 120).unwrap();
        open(&mut app);
        assert_eq!(app.layout_picker.as_ref().unwrap().selected, 0);
        press(&mut app, KeyCode::Char('s'), 120);
        assert_eq!(
            app.layout_picker
                .as_ref()
                .unwrap()
                .naming
                .as_ref()
                .unwrap()
                .value,
            "Layout 1"
        );
        for _ in 0.."Layout 1".len() {
            press(&mut app, KeyCode::Backspace, 120);
        }
        type_text(&mut app, "Pair");
        press(&mut app, KeyCode::Enter, 120);
        let project = app.layouts.projects.get("nesvo").unwrap();
        assert_eq!(project.layouts.len(), 1);
        let saved = &project.layouts[0];
        assert_eq!(saved.name, "Pair");
        assert_eq!(
            saved.tree.slots()[0],
            Slot {
                role: Role::Agent,
                provider: Some(Program::Claude)
            }
        );
        assert_eq!(saved.tree.slots()[1].role, Role::Terminal);
        assert_eq!(app.layout_picker.as_ref().unwrap().selected, 4);
        press(&mut app, KeyCode::Char('r'), 120);
        type_text(&mut app, " work");
        press(&mut app, KeyCode::Enter, 120);
        press(&mut app, KeyCode::Char('D'), 120);
        let project = app.layouts.projects.get("nesvo").unwrap();
        assert_eq!(project.layouts[0].name, "Pair work");
        assert_eq!(project.default.as_deref(), Some("Pair work"));
        assert_eq!(project.active.as_deref(), Some("Pair work"));
        assert_eq!(
            app.layouts.default_layout(Some("nesvo")).unwrap().name,
            "Pair work"
        );
        press(&mut app, KeyCode::Up, 120);
        press(&mut app, KeyCode::Char('d'), 120);
        assert!(
            app.layout_picker
                .as_ref()
                .unwrap()
                .message
                .as_deref()
                .is_some_and(|message| message.contains("cannot be deleted"))
        );
        press(&mut app, KeyCode::Down, 120);
        press(&mut app, KeyCode::Char('d'), 120);
        let project = app.layouts.projects.get("nesvo").unwrap();
        assert!(project.layouts.is_empty() && project.default.is_none());
        press(&mut app, KeyCode::Esc, 120);
        assert!(app.layout_picker.is_none());
    }

    #[test]
    fn layouts_names_must_be_unique_and_bounded() {
        let mut library = Library::default();
        assert!(library.save(None, named("Agent + Terminal")).is_err());
        assert!(library.save(None, named(" padded")).is_err());
        assert!(library.save(None, named(&"x".repeat(41))).is_err());
        library.save(None, named("Mine")).unwrap();
        assert!(library.save(Some("repo"), named("Mine")).is_err());
        for index in 0..MAX_PROJECT_LAYOUTS {
            library
                .save(Some("repo"), named(&format!("Repo {index}")))
                .unwrap();
        }
        assert!(library.save(Some("repo"), named("One more")).is_err());
        assert_eq!(
            library.entries(Some("repo")).len(),
            4 + MAX_PROJECT_LAYOUTS + 1
        );
        assert_eq!(library.entries(None).len(), 5);
    }

    #[test]
    fn layouts_project_map_is_bounded_by_count_and_bytes() {
        let mut library = Library::default();
        for project in 0..MAX_PROJECTS + 8 {
            for index in 0..MAX_PROJECT_LAYOUTS {
                let mut layout = named(&format!("{project:02} {index} {}", "n".repeat(20)));
                layout.tree = shipped().pop().unwrap().tree;
                library
                    .save(Some(&format!("project-{project:02}")), layout)
                    .unwrap();
            }
        }
        assert!(library.projects.len() <= MAX_PROJECTS);
        assert!(serde_json::to_vec(&library).unwrap().len() <= LIBRARY_BYTES);
        assert!(library.projects.contains_key("project-39"));
        assert!(!library.projects.contains_key("project-00"));
        let reloaded: Library =
            serde_json::from_slice(&serde_json::to_vec(&library).unwrap()).unwrap();
        assert_eq!(reloaded.clone().sanitized(), library);
    }

    #[test]
    fn layouts_sanitize_drops_invalid_entries_and_dangling_marks() {
        let raw = json!({
            "host": {"layouts": [
                {"name":"Good","tree":{"kind":"leaf","role":"agent","provider":"codex"}},
                {"name":"Good","tree":{"kind":"leaf","role":"terminal"}},
                {"name":"","tree":{"kind":"leaf","role":"terminal"}},
                {"name":"Quad","tree":{"kind":"leaf","role":"terminal"}}
            ], "active":"Missing", "default":"Quad"},
            "projects": {"": {"layouts": []}, "repo": {"used": 9}},
            "clock": 2
        });
        let library = serde_json::from_value::<Library>(raw).unwrap().sanitized();
        assert_eq!(library.host.layouts.len(), 1);
        assert_eq!(library.host.layouts[0].sidebar_mode, SIDEBAR_SESSIONS);
        assert_eq!(library.host.active, None);
        assert_eq!(library.host.default.as_deref(), Some("Quad"));
        assert_eq!(library.projects.keys().collect::<Vec<_>>(), ["repo"]);
        assert_eq!(library.clock, 9);
    }
}
