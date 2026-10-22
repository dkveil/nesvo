use crate::{
    layouts::{Library, MAX_LEAVES, PaneTree},
    model::App,
};
use anyhow::{Result, ensure};
use nesvo_wire::views::lenient;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashSet, fs, path::Path};

const FILE_BYTES: usize = 64 * 1024;

#[derive(Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceLayout {
    tabs: Vec<String>,
    #[serde(deserialize_with = "lenient")]
    panes: Vec<Option<String>>,
    recent: Vec<String>,
    collapsed: HashSet<String>,
    split: bool,
    fullscreen: bool,
    sidebar_width: u16,
    focused: usize,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    tree: Option<PaneTree>,
    #[serde(deserialize_with = "lenient")]
    library: Library,
    #[serde(deserialize_with = "lenient")]
    files: crate::files_controller::Saved,
    #[serde(deserialize_with = "lenient")]
    notes: crate::notes::Saved,
}
impl WorkspaceLayout {
    pub fn capture(app: &App) -> Self {
        Self {
            tabs: app.tabs.clone(),
            panes: app.panes.to_vec(),
            recent: app.recent_sessions.clone(),
            collapsed: app.collapsed.clone(),
            split: app.split,
            fullscreen: app.fullscreen,
            sidebar_width: app.sidebar_width,
            focused: app.focused,
            tree: app.pane_layout.clone(),
            library: app.layouts.clone(),
            files: app.files.capture(),
            notes: app.notes.saved(),
        }
    }
    pub fn library(&self) -> Library {
        self.library.clone().sanitized()
    }
    pub fn load(path: &Path) -> Result<Self> {
        ensure!(
            fs::metadata(path)?.len() <= FILE_BYTES as u64,
            "Layout file is too large"
        );
        Ok(serde_json::from_slice(&fs::read(path)?)?)
    }
    pub fn save(&self, path: &Path) -> Result<()> {
        let bytes = serde_json::to_vec(self)?;
        ensure!(bytes.len() <= FILE_BYTES, "Layout file is too large");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
        fs::write(&temporary, bytes)?;
        fs::rename(temporary, path)?;
        Ok(())
    }
    pub fn apply(&self, app: &mut App) -> Vec<Value> {
        let mut commands = Vec::new();
        app.pane_layout = self.tree.clone().filter(PaneTree::valid);
        app.split = self.split;
        app.fullscreen = self.fullscreen;
        app.sidebar_width = self.sidebar_width;
        app.files.restore(&self.files);
        app.notes.restore(&self.notes);
        let count = app.leaf_count();
        let slots = app.pane_tree().slots();
        for (index, slot) in slots.iter().enumerate().take(count.min(MAX_LEAVES)) {
            if let Some(id) = self
                .panes
                .get(index)
                .and_then(Option::as_deref)
                .filter(|id| app.session(id).is_some())
                .filter(|_| slot.role.hosts_session())
            {
                app.focused = index;
                let opened = app.open_session(id);
                if app.session(id).is_some_and(|session| session.hibernated()) {
                    app.subscribed.remove(id);
                    commands.extend(opened.into_iter().filter(|command| {
                        command["type"] != "subscribe" || command["sessionId"] != id
                    }));
                } else {
                    commands.extend(opened);
                }
            }
        }
        app.focused = self.focused.min(count - 1);
        app.focus_session_leaf();
        app.clear_hidden_panes();
        app.tabs = self
            .tabs
            .iter()
            .filter(|id| app.session(id).is_some())
            .cloned()
            .collect();
        for id in app.panes.iter().flatten() {
            if !app.tabs.contains(id) {
                app.tabs.push(id.clone());
            }
        }
        app.recent_sessions = self
            .recent
            .iter()
            .filter(|id| app.session(id).is_some())
            .take(32)
            .cloned()
            .collect();
        app.collapsed = self
            .collapsed
            .iter()
            .filter(|id| app.groups.iter().any(|g| &g.id == *id))
            .cloned()
            .collect();
        commands
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn restoration_filters_deleted_ids_and_never_starts_or_controls_processes() {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","groups":[],"sessions":[{"id":"s","name":"shell","cwd":".","running":true,"cols":80,"rows":24,"groupId":null,"controllerId":null}]})).unwrap();
        let saved = WorkspaceLayout {
            tabs: vec!["deleted".into(), "s".into()],
            panes: vec![Some("s".into()), None],
            focused: 99,
            ..Default::default()
        };
        let commands = saved.apply(&mut app);
        assert_eq!(app.tabs, ["s"]);
        assert_eq!(app.focused, 0);
        assert!(commands.iter().all(|c| c["type"] == "subscribe"
            || c["type"] == "unsubscribe"
            || c["type"] == "releaseControl"));
        assert!(app.mode == crate::model::Mode::Navigate);
    }

    fn snapshot(app: &mut App) {
        app.event(json!({"type":"sessions","groups":[],"sessions":[
            {"id":"a","name":"agent","cwd":".","program":"claude","running":true,"cols":80,"rows":24,"groupId":null,"controllerId":null},
            {"id":"t","name":"shell","cwd":".","running":true,"cols":80,"rows":24,"groupId":null,"controllerId":null}
        ]})).unwrap();
    }

    fn temporary(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "nesvo-workspace-layout-{name}-{}.json",
            std::process::id()
        ))
    }

    #[test]
    fn workspace_layout_legacy_file_without_layout_fields_still_restores() {
        let path = temporary("legacy");
        fs::write(
            &path,
            r#"{"tabs":["a","t"],"panes":["a","t"],"recent":["t"],"collapsed":[],"split":true,"fullscreen":false,"sidebar_width":30,"focused":1}"#,
        )
        .unwrap();
        let saved = WorkspaceLayout::load(&path).unwrap();
        fs::remove_file(&path).unwrap();
        assert_eq!(saved.tree, None);
        assert_eq!(saved.library, Library::default());
        let mut app = App::new(1);
        snapshot(&mut app);
        let commands = saved.apply(&mut app);
        assert_eq!(app.panes[..2], [Some("a".into()), Some("t".into())]);
        assert_eq!(app.focused, 1);
        assert_eq!(app.sidebar_width, 30);
        assert_eq!(app.leaf_count(), 2);
        assert!(commands.iter().all(|c| c["type"] != "acquireControl"));
    }

    fn restarted(app: &mut App, hibernated: bool) {
        let mut queued = json!({"id":"h","name":"queued","cwd":".","program":"claude","running":!hibernated,"cols":80,"rows":24,"groupId":null,"controllerId":null});
        if hibernated {
            queued["hibernation"] = json!({"state":"hibernated","hibernatedAt":1,"conversationId":"0f8fad5b-d9cb-469f-a165-70867728950e","trigger":"shutdown","lastResumeFailure":null});
        }
        app.event(json!({"type":"sessions","groups":[],"sessions":[
            {"id":"a","name":"agent","cwd":".","program":"claude","running":true,"cols":80,"rows":24,"groupId":null,"controllerId":null},
            queued
        ]})).unwrap();
    }

    #[test]
    fn workspace_layout_reattaches_restored_ids_and_defers_sessions_still_hibernated() {
        let saved = WorkspaceLayout {
            panes: vec![Some("a".into()), Some("h".into())],
            tabs: vec!["a".into(), "h".into()],
            split: true,
            focused: 1,
            ..Default::default()
        };
        let mut app = App::new(2);
        restarted(&mut app, true);
        let commands = saved.apply(&mut app);
        assert_eq!(app.panes[..2], [Some("a".into()), Some("h".into())]);
        assert_eq!(app.tabs, ["a", "h"]);
        assert!(
            commands
                .iter()
                .any(|c| c["type"] == "subscribe" && c["sessionId"] == "a")
        );
        assert!(
            commands
                .iter()
                .all(|c| !(c["type"] == "subscribe" && c["sessionId"] == "h"))
        );
        assert!(app.subscribed.contains("a") && !app.subscribed.contains("h"));
        restarted(&mut app, false);
        assert_eq!(app.panes[1].as_deref(), Some("h"));
        assert!(
            app.open_session("h")
                .iter()
                .any(|c| c["type"] == "subscribe" && c["sessionId"] == "h")
        );
    }

    #[test]
    fn workspace_layout_malformed_layout_fields_do_not_block_the_restore() {
        let saved: WorkspaceLayout = serde_json::from_value(json!({
            "panes": ["a", null, null, null, "extra"],
            "split": false,
            "tree": {"kind":"leaf","role":"unknown"},
            "library": {"host": 7}
        }))
        .unwrap();
        assert_eq!(saved.tree, None);
        assert_eq!(saved.library, Library::default());
        let mut app = App::new(1);
        snapshot(&mut app);
        saved.apply(&mut app);
        assert_eq!(app.active_id(), Some("a"));
        assert_eq!(app.leaf_count(), 1);
    }

    #[test]
    fn workspace_layout_round_trip_keeps_tree_and_project_map_and_never_controls() {
        let mut app = App::new(1);
        snapshot(&mut app);
        let quad = crate::layouts::shipped().pop().unwrap();
        crate::layouts::apply(&mut app, &quad, 160).unwrap();
        let mut custom = app.current_layout("Mine");
        custom.sidebar_width = 36;
        app.layouts.save(Some("nesvo"), custom).unwrap();
        app.layouts.toggle_default(Some("nesvo"), "Mine");
        let path = temporary("round-trip");
        let captured = WorkspaceLayout::capture(&app);
        captured.save(&path).unwrap();
        let loaded = WorkspaceLayout::load(&path).unwrap();
        fs::remove_file(&path).unwrap();
        assert!(loaded == captured);
        assert_eq!(loaded.library(), app.layouts);
        let project = &loaded.library().projects["nesvo"];
        assert_eq!(project.default.as_deref(), Some("Mine"));
        assert_eq!(project.layouts[0].sidebar_width, 36);

        let mut restored = App::new(2);
        snapshot(&mut restored);
        restored.layouts = loaded.library();
        let commands = loaded.apply(&mut restored);
        assert_eq!(restored.leaf_count(), 4);
        assert_eq!(restored.pane_tree(), quad.tree);
        assert_eq!(restored.panes, app.panes);
        assert!(commands.iter().all(|c| c["type"] == "subscribe"
            || c["type"] == "unsubscribe"
            || c["type"] == "releaseControl"));
        assert!(restored.mode == crate::model::Mode::Navigate);
    }

    #[test]
    fn workspace_layout_file_stays_under_the_cap_with_a_full_project_map() {
        let mut app = App::new(1);
        snapshot(&mut app);
        for project in 0..crate::layouts::MAX_PROJECTS * 2 {
            for index in 0..crate::layouts::MAX_PROJECT_LAYOUTS {
                let mut layout = crate::layouts::shipped().pop().unwrap();
                layout.name = format!("{project:03}-{index}-{}", "w".repeat(30));
                app.layouts
                    .save(Some(&format!("{project:03}-{}", "p".repeat(100))), layout)
                    .unwrap();
            }
        }
        let path = temporary("cap");
        WorkspaceLayout::capture(&app).save(&path).unwrap();
        let size = fs::metadata(&path).unwrap().len();
        fs::remove_file(&path).unwrap();
        assert!(size <= FILE_BYTES as u64);
        assert!(app.layouts.projects.len() <= crate::layouts::MAX_PROJECTS);
    }
}
