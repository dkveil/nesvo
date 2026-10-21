use crate::model::Session;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub const PREFIX: char = '%';
const PENDING_LIMIT: usize = 8;
const DEFAULTS_LIMIT: usize = 64;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub root: String,
    pub name: String,
    #[serde(default)]
    pub default_branch: Option<String>,
    #[serde(default)]
    pub last_activity_at: u64,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub open_sessions: usize,
    #[serde(default)]
    pub sessions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub folder: String,
    #[serde(default)]
    pub launches: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Defaults {
    pub root: String,
    pub name: String,
    #[serde(default)]
    pub default_layout: Option<String>,
    pub launch_folder: String,
    #[serde(default)]
    pub folders: Vec<Folder>,
    #[serde(default)]
    pub worktree_setup: Value,
}

impl Defaults {
    pub fn setup_state(&self) -> &'static str {
        let setup = &self.worktree_setup;
        if setup["available"] != true {
            return "registry unavailable";
        }
        match (&setup["configured"], &setup["approved"]) {
            (Value::Bool(true), Value::Bool(true)) => "approved",
            (Value::Bool(true), _) => "needs approval",
            _ if setup.get("error").is_some() => "nesvo.toml unreadable",
            _ => "no nesvo.toml setup",
        }
    }

    pub fn open_worktrees(&self) -> u64 {
        self.worktree_setup["openWorktrees"].as_u64().unwrap_or(0)
    }

    pub fn digest(&self) -> Option<&str> {
        self.worktree_setup["digest"].as_str()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Intent {
    Launch,
    Layout { width: u16 },
    Setup,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    List,
    Defaults { root: String, intent: Intent },
    Pin { root: String },
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Load {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Filter {
    pub root: String,
    pub name: String,
    pub sessions: HashSet<String>,
}

#[derive(Default)]
pub struct Projects {
    pub open: bool,
    pub load: Load,
    pub items: Vec<Project>,
    pub selected: usize,
    pub received_ms: u64,
    pub defaults: HashMap<String, Defaults>,
    pub detail: Option<String>,
    pub filter: Option<Filter>,
    pub launch_folder: Option<String>,
    pending: Vec<(String, Request)>,
}

impl Projects {
    pub fn track(&mut self, request_id: &str, request: Request) {
        if self.pending.len() >= PENDING_LIMIT {
            self.pending.remove(0);
        }
        self.pending.push((request_id.to_owned(), request));
    }

    pub fn take(&mut self, request_id: &str) -> Option<Request> {
        let index = self.pending.iter().position(|(id, _)| id == request_id)?;
        Some(self.pending.remove(index).1)
    }

    pub fn listing(&self) -> bool {
        self.pending
            .iter()
            .any(|(_, request)| *request == Request::List)
    }

    pub fn accept_list(&mut self, value: &Value, now_ms: u64) -> bool {
        let Ok(mut items) = serde_json::from_value::<Vec<Project>>(value["projects"].clone())
        else {
            self.load = Load::Failed("The host sent an unreadable project list.".into());
            return false;
        };
        let selected = self.selected_project().map(|project| project.root.clone());
        items.sort_by(|left, right| {
            right
                .pinned
                .cmp(&left.pinned)
                .then(right.last_activity_at.cmp(&left.last_activity_at))
                .then_with(|| left.root.cmp(&right.root))
        });
        self.items = items;
        self.selected = selected
            .and_then(|root| self.items.iter().position(|project| project.root == root))
            .unwrap_or(0)
            .min(self.items.len().saturating_sub(1));
        self.defaults
            .retain(|root, _| self.items.iter().any(|project| &project.root == root));
        if let Some(filter) = &mut self.filter
            && let Some(project) = self
                .items
                .iter()
                .find(|project| project.root == filter.root)
        {
            filter.sessions = project.sessions.iter().cloned().collect();
        }
        self.received_ms = now_ms;
        self.load = Load::Ready;
        true
    }

    pub fn accept_defaults(&mut self, value: &Value) -> Option<Defaults> {
        let defaults = serde_json::from_value::<Defaults>(value.clone()).ok()?;
        if self.defaults.len() >= DEFAULTS_LIMIT && !self.defaults.contains_key(&defaults.root) {
            self.defaults.clear();
        }
        self.defaults
            .insert(defaults.root.clone(), defaults.clone());
        Some(defaults)
    }

    pub fn set_pinned(&mut self, root: &str, pinned: bool) {
        if let Some(project) = self.items.iter_mut().find(|project| project.root == root) {
            project.pinned = pinned;
        }
    }

    pub fn selected_project(&self) -> Option<&Project> {
        self.items.get(self.selected)
    }

    pub fn find(&self, root: &str) -> Option<&Project> {
        self.items.iter().find(|project| project.root == root)
    }

    pub fn select_root(&mut self, root: &str) {
        if let Some(index) = self.items.iter().position(|project| project.root == root) {
            self.selected = index;
        }
    }

    pub fn move_selection(&mut self, delta: isize) {
        if self.items.is_empty() {
            return;
        }
        let last = self.items.len() - 1;
        self.selected = self.selected.saturating_add_signed(delta).min(last);
    }

    pub fn toggle_filter(&mut self) -> Option<bool> {
        let project = self.selected_project()?.clone();
        if self
            .filter
            .as_ref()
            .is_some_and(|filter| filter.root == project.root)
        {
            self.filter = None;
            return Some(false);
        }
        self.filter = Some(Filter {
            root: project.root,
            name: project.name,
            sessions: project.sessions.into_iter().collect(),
        });
        Some(true)
    }

    pub fn allows(&self, session: &Session) -> bool {
        let Some(filter) = &self.filter else {
            return true;
        };
        filter.sessions.contains(&session.id)
            || session
                .repository_context
                .as_ref()
                .and_then(|context| context.root())
                .is_some_and(|root| root == filter.root)
    }
}

pub fn query(text: &str) -> Option<&str> {
    text.trim_start().strip_prefix(PREFIX).map(str::trim)
}

pub fn matches(project: &Project, query: &str) -> bool {
    let haystack = format!("{} {}", project.name, project.root).to_lowercase();
    query.split_whitespace().all(|word| {
        let mut characters = haystack.chars();
        word.to_lowercase()
            .chars()
            .all(|wanted| characters.any(|candidate| candidate == wanted))
    })
}

pub fn age(received_ms: u64, at: u64) -> String {
    if at == 0 {
        return "no activity".into();
    }
    let seconds = received_ms.saturating_sub(at) / 1000;
    match seconds {
        0..60 => "just now".into(),
        60..3600 => format!("{}m ago", seconds / 60),
        3600..86_400 => format!("{}h ago", seconds / 3600),
        _ => format!("{}d ago", seconds / 86_400),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn listing() -> Value {
        json!({"type":"projects","limit":256,"projects":[
            {"root":"C:/dev/beta","name":"beta","defaultBranch":null,"lastActivityAt":5_000,"pinned":false,"openSessions":0,"sessions":[]},
            {"root":"C:/dev/nesvo","name":"nesvo","defaultBranch":"main","lastActivityAt":9_000,"pinned":false,"openSessions":1,"sessions":["s1"]},
            {"root":"C:/dev/archive","name":"archive","defaultBranch":"trunk","lastActivityAt":1_000,"pinned":true,"openSessions":0,"sessions":[]}
        ]})
    }

    pub(crate) fn defaults(root: &str, layout: Option<&str>) -> Value {
        json!({"type":"projectDefaults","root":root,"name":"nesvo","defaultLayout":layout,
            "launchFolder":format!("{root}/apps/tui"),"folders":[{"folder":format!("{root}/apps/tui"),"launches":3,"lastLaunchAt":9}],
            "worktreeSetup":{"available":true,"configured":true,"approved":false,"digest":"ab".repeat(32),"openWorktrees":2}})
    }

    #[test]
    fn projects_list_sorts_pinned_then_activity_and_keeps_the_selection() {
        let mut projects = Projects::default();
        assert!(projects.accept_list(&listing(), 10_000));
        let names: Vec<&str> = projects.items.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["archive", "nesvo", "beta"]);
        projects.selected = 2;
        let mut update = listing();
        update["projects"][0]["lastActivityAt"] = json!(20_000);
        assert!(projects.accept_list(&update, 30_000));
        assert_eq!(projects.selected_project().unwrap().name, "beta");
        assert!(!projects.accept_list(&json!({"projects":"broken"}), 1));
        assert!(matches!(projects.load, Load::Failed(_)));
    }

    #[test]
    fn projects_defaults_summarize_worktree_setup_and_pick_the_usual_folder() {
        let mut projects = Projects::default();
        let defaults = projects
            .accept_defaults(&defaults("C:/dev/nesvo", Some("Quad")))
            .unwrap();
        assert_eq!(defaults.launch_folder, "C:/dev/nesvo/apps/tui");
        assert_eq!(defaults.setup_state(), "needs approval");
        assert_eq!(defaults.open_worktrees(), 2);
        let mut approved = defaults.clone();
        approved.worktree_setup["approved"] = json!(true);
        assert_eq!(approved.setup_state(), "approved");
        approved.worktree_setup = json!({"available":false});
        assert_eq!(approved.setup_state(), "registry unavailable");
        assert_eq!(defaults.digest().map(str::len), Some(64));
        assert!(projects.accept_defaults(&json!({"root":1})).is_none());
        assert_eq!(age(120_000, 60_000), "1m ago");
        assert_eq!(age(10, 0), "no activity");
        assert_eq!(query(" % nes "), Some("nes"));
        assert!(query("nes").is_none());
    }
}
