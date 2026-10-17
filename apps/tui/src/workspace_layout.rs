//! Per-host presentation state. Restoring a layout never acquires terminal control.
use crate::model::App;
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashSet, fs, path::Path};

#[derive(Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceLayout {
    tabs: Vec<String>,
    panes: [Option<String>; 2],
    recent: Vec<String>,
    collapsed: HashSet<String>,
    split: bool,
    fullscreen: bool,
    focused: usize,
}
impl WorkspaceLayout {
    pub fn capture(app: &App) -> Self {
        Self {
            tabs: app.tabs.clone(),
            panes: app.panes.clone(),
            recent: app.recent_sessions.clone(),
            collapsed: app.collapsed.clone(),
            split: app.split,
            fullscreen: app.fullscreen,
            focused: app.focused,
        }
    }
    pub fn load(path: &Path) -> Result<Self> {
        ensure!(
            fs::metadata(path)?.len() <= 64 * 1024,
            "Layout file is too large"
        );
        Ok(serde_json::from_slice(&fs::read(path)?)?)
    }
    pub fn save(&self, path: &Path) -> Result<()> {
        let bytes = serde_json::to_vec(self)?;
        ensure!(bytes.len() <= 64 * 1024, "Layout file is too large");
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
        app.split = self.split;
        app.fullscreen = self.fullscreen;
        for index in 0..if self.split { 2 } else { 1 } {
            if let Some(id) = self.panes[index]
                .as_deref()
                .filter(|id| app.session(id).is_some())
            {
                app.focused = index;
                commands.extend(app.open_session(id));
            }
        }
        app.focused = self.focused.min(usize::from(app.split));
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
            panes: [Some("s".into()), None],
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
}
