use crate::{
    controller::Outcome,
    model::{App, Dialog},
    palette::{ResultRow, Target},
    projects::{Defaults, Intent, Load, Project, Request},
};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::layout::Rect;
use serde_json::{Value, json};

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

pub fn supported(app: &App) -> bool {
    app.host_features["projects"] == true
}

fn request_list(app: &mut App) -> Value {
    let command = app.request(json!({"type":"listProjects"}));
    if let Some(id) = command["requestId"].as_str() {
        app.projects.track(id, Request::List);
    }
    if app.projects.items.is_empty() || matches!(app.projects.load, Load::Failed(_)) {
        app.projects.load = Load::Loading;
    }
    command
}

fn request_defaults(app: &mut App, root: String, intent: Intent) -> Value {
    let command = app.request(json!({"type":"projectDefaults","root":root}));
    if let Some(id) = command["requestId"].as_str() {
        app.projects.track(id, Request::Defaults { root, intent });
    }
    command
}

pub fn open(app: &mut App, outcome: &mut Outcome) {
    if !supported(app) {
        app.notice = "Update the host to browse projects.".into();
        return;
    }
    app.projects.open = true;
    app.projects.detail = None;
    app.notice.clear();
    outcome.commands.push(request_list(app));
}

pub fn reveal(app: &mut App, root: &str, outcome: &mut Outcome) {
    open(app, outcome);
    app.projects.select_root(root);
}

fn close(app: &mut App) {
    if app.projects.detail.take().is_none() {
        app.projects.open = false;
        app.notice.clear();
    }
}

fn launch(app: &mut App, folder: String) {
    app.projects.open = false;
    app.projects.detail = None;
    app.dialog = None;
    app.dialog_button = None;
    app.session_kind = Some(crate::session_kind::Picker::default());
    app.notice = format!("New session in {folder}");
    app.projects.launch_folder = Some(folder);
}

pub fn layout_for(
    app: &App,
    project: &Project,
    host_layout: Option<&str>,
) -> Option<crate::layouts::NamedLayout> {
    let key = app
        .layouts
        .project_key(Some(&project.root), Some(&project.name))?;
    app.layouts
        .project_default(&key)
        .or_else(|| host_layout.and_then(|name| app.layouts.named(Some(&key), name)))
}

fn apply_layout(
    app: &mut App,
    project: &Project,
    host_layout: Option<&str>,
    width: u16,
) -> Vec<Value> {
    let Some(layout) = layout_for(app, project, host_layout) else {
        app.notice = format!(
            "{} has no default layout; mark one in Layouts (L) or with nesvo project layout.",
            project.name
        );
        return Vec::new();
    };
    match crate::layouts::apply(app, &layout, width) {
        Ok(commands) => {
            app.projects.open = false;
            app.projects.detail = None;
            app.notice = format!("{} applied for {}", layout.name, project.name);
            commands
        }
        Err(message) => {
            app.notice = message;
            Vec::new()
        }
    }
}

fn toggle_filter(app: &mut App) {
    let Some(enabled) = app.projects.toggle_filter() else {
        return;
    };
    app.selected = 0;
    app.notice = match (&app.projects.filter, enabled) {
        (Some(filter), true) => format!(
            "Sidebar and palette show sessions of {}; press s here again to show all.",
            filter.name
        ),
        _ => "Sidebar and palette show all sessions again.".into(),
    };
}

fn toggle_pin(app: &mut App) -> Option<Value> {
    let project = app.projects.selected_project()?.clone();
    let kind = if project.pinned {
        "unpinProject"
    } else {
        "pinProject"
    };
    let command = app.request(json!({"type":kind,"root":project.root}));
    if let Some(id) = command["requestId"].as_str() {
        app.projects.track(id, Request::Pin { root: project.root });
    }
    Some(command)
}

pub fn event(app: &mut App, event: Event, area: Rect) -> Outcome {
    let mut outcome = Outcome::default();
    match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => {
            key_event(app, key, area.width, &mut outcome)
        }
        Event::Resize(..) => {}
        _ => outcome.redraw = false,
    }
    outcome
}

fn key_event(app: &mut App, key: KeyEvent, width: u16, outcome: &mut Outcome) {
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        outcome.quit = true;
        return;
    }
    if key.code == KeyCode::Esc {
        return close(app);
    }
    if key.code == KeyCode::Char('r') {
        outcome.commands.push(request_list(app));
        return;
    }
    if app.projects.load != Load::Ready {
        outcome.redraw = false;
        return;
    }
    let Some(project) = app.projects.selected_project().cloned() else {
        outcome.redraw = false;
        return;
    };
    let cached = app.projects.defaults.get(&project.root).cloned();
    match key.code {
        KeyCode::Up | KeyCode::Char('k') => app.projects.move_selection(-1),
        KeyCode::Down | KeyCode::Char('j') => app.projects.move_selection(1),
        KeyCode::Home => app.projects.selected = 0,
        KeyCode::End => app.projects.move_selection(isize::MAX),
        KeyCode::Enter => match cached {
            Some(defaults) => launch(app, defaults.launch_folder),
            None => outcome
                .commands
                .push(request_defaults(app, project.root, Intent::Launch)),
        },
        KeyCode::Char('l') => {
            if layout_for(app, &project, None).is_some() || cached.is_some() {
                let host = cached.and_then(|defaults| defaults.default_layout);
                outcome
                    .commands
                    .extend(apply_layout(app, &project, host.as_deref(), width));
            } else {
                outcome.commands.push(request_defaults(
                    app,
                    project.root,
                    Intent::Layout { width },
                ));
            }
        }
        KeyCode::Char('w') => {
            if app.projects.detail.as_deref() == Some(project.root.as_str()) {
                app.projects.detail = None;
            } else {
                outcome
                    .commands
                    .push(request_defaults(app, project.root, Intent::Setup));
            }
        }
        KeyCode::Char('s') => toggle_filter(app),
        KeyCode::Char('p') => outcome.commands.extend(toggle_pin(app)),
        _ => outcome.redraw = false,
    }
}

fn message(event: &Value) -> String {
    event["message"]
        .as_str()
        .unwrap_or("The host refused the project request.")
        .to_owned()
}

fn answer_defaults(app: &mut App, defaults: Defaults, intent: Intent) -> Vec<Value> {
    let current = app.projects.open
        && app
            .projects
            .selected_project()
            .is_some_and(|project| project.root == defaults.root);
    if !current {
        return Vec::new();
    }
    match intent {
        Intent::Launch => {
            launch(app, defaults.launch_folder);
            Vec::new()
        }
        Intent::Setup => {
            app.projects.detail = Some(defaults.root);
            Vec::new()
        }
        Intent::Layout { width } => {
            let Some(project) = app.projects.find(&defaults.root).cloned() else {
                return Vec::new();
            };
            apply_layout(app, &project, defaults.default_layout.as_deref(), width)
        }
    }
}

pub fn expire(app: &mut App) -> bool {
    let expired = app.projects.expire();
    if expired
        .iter()
        .any(|request| !matches!(request, Request::List))
    {
        app.notice = "The host did not answer the project request; try again.".into();
    }
    !expired.is_empty()
}

pub fn host_event(app: &mut App, event: &Value) -> Option<Vec<Value>> {
    let request = event["requestId"].as_str()?;
    let sent = app.projects.take(request)?;
    let failed = event["type"] == "error";
    let mut commands = Vec::new();
    match sent {
        Request::List if failed => app.projects.load = Load::Failed(message(event)),
        Request::List => {
            app.projects.accept_list(event, now_ms());
        }
        Request::Pin { .. } if failed => app.notice = message(event),
        Request::Pin { root } => {
            app.projects.set_pinned(&root, event["pinned"] == true);
            commands.push(request_list(app));
        }
        Request::Defaults { .. } if failed => app.notice = message(event),
        Request::Defaults { intent, .. } => match app.projects.accept_defaults(event) {
            Some(defaults) => commands.extend(answer_defaults(app, defaults, intent)),
            None => app.notice = "The host sent unreadable project defaults.".into(),
        },
    }
    Some(commands)
}

fn palette_query(app: &App) -> Option<&str> {
    match &app.dialog {
        Some(Dialog::QuickSwitch { query, .. }) => crate::projects::query(query),
        _ => None,
    }
}

pub fn sync(app: &mut App) -> Vec<Value> {
    if palette_query(app).is_none()
        || !app.connected
        || !supported(app)
        || app.projects.listing()
        || matches!(app.projects.load, Load::Ready | Load::Loading)
    {
        return Vec::new();
    }
    vec![request_list(app)]
}

pub fn palette_rows(app: &App, query: &str) -> Option<Vec<ResultRow>> {
    let wanted = crate::projects::query(query)?;
    Some(
        app.projects
            .items
            .iter()
            .filter(|project| crate::projects::matches(project, wanted))
            .map(|project| ResultRow {
                target: Target::Project(project.root.clone()),
                title: project.name.clone(),
                context: format!(
                    "Project{} · {} open · {}",
                    if project.pinned { " · pinned" } else { "" },
                    project.open_sessions,
                    project.root
                ),
            })
            .collect(),
    )
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::projects::tests::{defaults, listing};

    fn app() -> App {
        let mut app = App::new(9);
        app.event(
            json!({"type":"capabilities","workspace":"C:/dev","projects":true,"programs":[
                {"id":"claude","available":true}
            ]}),
        )
        .unwrap();
        app.event(json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"s1","name":"Agent","cwd":"C:/dev/nesvo","program":"claude","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null,
             "repositoryContext":{"source":"launchDirectory","state":"ready","name":"nesvo","branch":"main","observedAt":1,"revision":1,"root":"C:/dev/nesvo"}},
            {"id":"s2","name":"Other","cwd":"C:/dev/beta","program":"shell","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]}))
        .unwrap();
        app.dialog = None;
        app.overlay = None;
        app.onboarded = true;
        app.notice.clear();
        app
    }

    fn press(app: &mut App, code: KeyCode) -> Vec<Value> {
        event(
            app,
            Event::Key(KeyEvent::new(code, KeyModifiers::NONE)),
            Rect::new(0, 0, 150, 44),
        )
        .commands
    }

    pub(crate) fn loaded() -> App {
        let mut app = app();
        let mut outcome = Outcome::default();
        open(&mut app, &mut outcome);
        assert_eq!(outcome.commands.len(), 1);
        assert_eq!(outcome.commands[0]["type"], "listProjects");
        let mut response = listing();
        response["requestId"] = outcome.commands[0]["requestId"].clone();
        app.event(response).unwrap();
        assert_eq!(app.projects.load, Load::Ready);
        app
    }

    fn reply(app: &mut App, command: &Value, mut response: Value) -> Vec<Value> {
        response["requestId"] = command["requestId"].clone();
        app.event(response).unwrap()
    }

    #[test]
    fn projects_key_opens_the_view_and_requests_the_list_only_on_capable_hosts() {
        let mut app = app();
        let commands = crate::controller::event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('P'), KeyModifiers::NONE)),
            Rect::new(0, 0, 100, 32),
        )
        .commands;
        assert!(app.projects.open);
        assert_eq!(
            commands,
            vec![json!({"type":"listProjects","requestId":commands[0]["requestId"]})]
        );
        let mut old = App::new(1);
        let mut outcome = Outcome::default();
        open(&mut old, &mut outcome);
        assert!(!old.projects.open);
        assert!(outcome.commands.is_empty());
        assert!(old.notice.contains("Update the host"));
    }

    #[test]
    fn projects_enter_requests_defaults_then_opens_the_kind_picker_in_the_usual_folder() {
        let mut app = loaded();
        press(&mut app, KeyCode::Down);
        assert_eq!(app.projects.selected_project().unwrap().name, "nesvo");
        let commands = press(&mut app, KeyCode::Enter);
        assert_eq!(commands[0]["type"], "projectDefaults");
        assert_eq!(commands[0]["root"], "C:/dev/nesvo");
        assert!(app.session_kind.is_none());
        reply(&mut app, &commands[0], defaults("C:/dev/nesvo", None));
        assert!(!app.projects.open);
        assert!(app.session_kind.is_some());
        assert_eq!(
            app.projects.launch_folder.as_deref(),
            Some("C:/dev/nesvo/apps/tui")
        );
        crate::controller::event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Rect::new(0, 0, 150, 44),
        );
        assert!(
            matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.cwd == "C:/dev/nesvo/apps/tui")
        );
        assert!(app.projects.launch_folder.is_none());
    }

    #[test]
    fn projects_pin_sends_the_command_and_relists_and_errors_stay_in_the_view() {
        let mut app = loaded();
        let commands = press(&mut app, KeyCode::Char('p'));
        assert_eq!(commands[0]["type"], "unpinProject");
        assert_eq!(commands[0]["root"], "C:/dev/archive");
        let next = reply(
            &mut app,
            &commands[0],
            json!({"type":"projectPinned","root":"C:/dev/archive","pinned":false}),
        );
        assert_eq!(next[0]["type"], "listProjects");
        press(&mut app, KeyCode::Down);
        let commands = press(&mut app, KeyCode::Char('p'));
        assert_eq!(commands[0]["type"], "pinProject");
        reply(
            &mut app,
            &commands[0],
            json!({"type":"error","code":"project_limit","message":"At most 64 projects can be pinned"}),
        );
        assert!(app.projects.open);
        assert_eq!(app.notice, "At most 64 projects can be pinned");
    }

    #[test]
    fn projects_sidebar_filter_keeps_only_the_project_sessions_and_toggles_off() {
        let mut app = loaded();
        press(&mut app, KeyCode::Down);
        assert!(press(&mut app, KeyCode::Char('s')).is_empty());
        let rows: Vec<String> = app.tree().into_iter().map(|row| row.label).collect();
        assert_eq!(rows, ["sessions · nesvo", "Agent"]);
        press(&mut app, KeyCode::Char('s'));
        assert_eq!(app.tree().len(), 3);
        assert_eq!(app.tree()[0].label, "sessions");
    }

    #[test]
    fn projects_layout_key_applies_local_default_or_host_default_and_explains_none() {
        let mut app = loaded();
        press(&mut app, KeyCode::Down);
        let commands = press(&mut app, KeyCode::Char('l'));
        assert_eq!(commands[0]["type"], "projectDefaults");
        reply(&mut app, &commands[0], defaults("C:/dev/nesvo", None));
        assert!(app.notice.contains("no default layout"));
        assert!(app.projects.open);
        let setup = press(&mut app, KeyCode::Char('w'));
        reply(
            &mut app,
            &setup[0],
            defaults("C:/dev/nesvo", Some("Agent + Terminal")),
        );
        assert_eq!(app.projects.detail.as_deref(), Some("C:/dev/nesvo"));
        assert!(
            press(&mut app, KeyCode::Char('l'))
                .iter()
                .all(|command| command["type"] != "projectDefaults")
        );
        assert!(!app.projects.open, "{}", app.notice);
        let mut local = loaded();
        let quad = crate::layouts::shipped().pop().unwrap();
        local
            .layouts
            .toggle_default(Some("C:/dev/nesvo"), &quad.name);
        press(&mut local, KeyCode::Down);
        let commands = press(&mut local, KeyCode::Char('l'));
        assert!(
            commands
                .iter()
                .all(|command| command["type"] != "projectDefaults")
        );
        assert!(!local.projects.open);
        assert_eq!(local.pane_tree(), quad.tree);
    }

    #[test]
    fn projects_palette_prefix_lists_once_shows_rows_and_reveals_the_project() {
        let mut app = app();
        app.begin_palette("%".into());
        let first = sync(&mut app);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["type"], "listProjects");
        assert!(sync(&mut app).is_empty());
        reply(&mut app, &first[0], listing());
        assert!(sync(&mut app).is_empty());
        let rows = palette_rows(&app, "%nes").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].target, Target::Project("C:/dev/nesvo".into()));
        assert!(palette_rows(&app, "nes").is_none());
        let mut outcome = Outcome::default();
        reveal(&mut app, "C:/dev/nesvo", &mut outcome);
        assert!(app.projects.open);
        assert_eq!(app.projects.selected_project().unwrap().name, "nesvo");
        assert_eq!(outcome.commands[0]["type"], "listProjects");
    }

    #[test]
    fn projects_repository_root_is_read_only_for_resolved_contexts() {
        let app = app();
        let context = app.sessions[0].repository_context.as_ref().unwrap();
        assert_eq!(context.root(), Some("C:/dev/nesvo"));
        let mut broken = App::new(2);
        broken
            .event(json!({"type":"sessions","revision":1,"groups":[],"sessions":[
                {"id":"x","name":"x","cwd":"/w","program":"shell","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null,
                 "repositoryContext":{"source":"launchDirectory","state":"notRepository","name":null,"branch":null,"observedAt":1,"revision":1,"root":"/w"}}
            ]}))
            .unwrap();
        assert!(broken.sessions[0].repository_context.is_none());
    }

    #[test]
    fn projects_disconnect_closes_the_view_and_forgets_host_state() {
        let mut app = loaded();
        press(&mut app, KeyCode::Down);
        let pending = press(&mut app, KeyCode::Enter);
        app.projects.launch_folder = Some("C:/dev/nesvo".into());
        app.disconnect("gone".into());
        assert!(!app.projects.open);
        assert_eq!(app.projects.load, Load::Idle);
        assert!(app.projects.items.is_empty() && app.projects.defaults.is_empty());
        assert!(app.projects.launch_folder.is_none() && !app.projects.listing());
        reply(&mut app, &pending[0], defaults("C:/dev/nesvo", None));
        assert!(app.session_kind.is_none());
        assert_eq!(
            app.top_surface(),
            crate::model::Surface::Workspace,
            "keys no longer route into a hidden view"
        );
    }

    #[test]
    fn projects_requests_expire_and_a_lost_list_stops_loading() {
        let mut app = app();
        let mut outcome = Outcome::default();
        open(&mut app, &mut outcome);
        assert_eq!(app.projects.load, Load::Loading);
        app.projects
            .age_requests(std::time::Duration::from_secs(21));
        assert!(expire(&mut app));
        assert!(
            matches!(&app.projects.load, Load::Failed(message) if message.contains("did not answer"))
        );
        assert!(!app.projects.listing());
        assert!(!expire(&mut app));
    }

    #[test]
    fn projects_pending_cap_never_evicts_the_list_request() {
        let mut app = app();
        let mut outcome = Outcome::default();
        open(&mut app, &mut outcome);
        let list = outcome.commands[0].clone();
        for index in 0..12 {
            app.projects.track(
                &format!("pin-{index}"),
                Request::Pin {
                    root: format!("C:/dev/{index}"),
                },
            );
        }
        assert!(app.projects.listing());
        reply(&mut app, &list, listing());
        assert_eq!(app.projects.load, Load::Ready);
    }

    #[test]
    fn projects_late_defaults_after_escape_or_another_selection_do_nothing() {
        let mut app = loaded();
        press(&mut app, KeyCode::Down);
        let launch = press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Esc);
        assert!(!app.projects.open);
        reply(&mut app, &launch[0], defaults("C:/dev/nesvo", None));
        assert!(app.session_kind.is_none() && app.projects.launch_folder.is_none());
        assert!(app.projects.defaults.contains_key("C:/dev/nesvo"));
        let mut moved = loaded();
        press(&mut moved, KeyCode::Down);
        let layout = press(&mut moved, KeyCode::Char('w'));
        press(&mut moved, KeyCode::Down);
        reply(
            &mut moved,
            &layout[0],
            defaults("C:/dev/nesvo", Some("Quad")),
        );
        assert!(moved.projects.detail.is_none());
        assert!(moved.projects.open);
    }
}
