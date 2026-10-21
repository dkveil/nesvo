use crate::{
    controller::Outcome,
    model::App,
    runs::{Effect, Load, Page, Runs},
};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

pub fn engaged(app: &App) -> bool {
    app.runs.as_ref().is_some_and(|runs| runs.open)
}

fn template_directory(app: &App) -> String {
    app.active_session()
        .map(|session| session.cwd.clone())
        .filter(|cwd| !cwd.trim().is_empty())
        .or_else(|| app.capabilities.as_ref().map(|caps| caps.workspace.clone()))
        .unwrap_or_default()
}

pub fn open(app: &mut App, outcome: &mut Outcome) {
    if let Some(runs) = app.runs.as_mut() {
        runs.open = true;
        runs.page = Page::Runs;
        app.notice.clear();
        let effect = runs.refresh(&app.host_features);
        apply(app, outcome, effect);
        return;
    }
    match Runs::open(app.client_id, &app.host_features) {
        Ok((runs, command)) => {
            app.runs = Some(runs);
            app.notice.clear();
            outcome.commands.push(command);
        }
        Err(_) => app.notice = "Update the host to manage durable runs.".into(),
    }
}

pub fn host_event(app: &mut App, event: &serde_json::Value) -> Vec<serde_json::Value> {
    let Some(runs) = app.runs.as_mut() else {
        return Vec::new();
    };
    let effect = if event["type"] == "error" {
        runs.failure(&app.host_features, event)
    } else {
        runs.response(&app.host_features, event)
    };
    let Some(effect) = effect else {
        return Vec::new();
    };
    if let Some(notice) = effect.notice {
        app.notice = notice;
    }
    effect.commands
}

fn apply(app: &mut App, outcome: &mut Outcome, effect: Effect) {
    if let Some(notice) = effect.notice {
        app.notice = notice;
    }
    outcome.commands.extend(effect.commands);
}

pub fn event(app: &mut App, event: Event) -> Outcome {
    let mut outcome = Outcome::default();
    match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => key_event(app, key, &mut outcome),
        Event::Paste(text) => {
            if let Some(form) = app.runs.as_mut().and_then(|runs| runs.answer.as_mut()) {
                form.text.push_str(&text);
            }
        }
        Event::Resize(..) => {}
        _ => outcome.redraw = false,
    }
    outcome
}

fn key_event(app: &mut App, key: KeyEvent, outcome: &mut Outcome) {
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        outcome.quit = true;
        return;
    }
    let directory = template_directory(app);
    let features = &app.host_features;
    let Some(runs) = app.runs.as_mut() else {
        return;
    };
    if runs.page == Page::Answer {
        let effect = answer_key(runs, features, key, outcome);
        return apply(app, outcome, effect);
    }
    if key.code == KeyCode::Esc {
        runs.back();
        app.notice.clear();
        return;
    }
    if key.code != KeyCode::Char('p') && runs.cancel_confirm() {
        app.notice.clear();
    }
    let effect = match (runs.page, key.code) {
        (_, KeyCode::F(5)) => runs.refresh(features),
        (Page::Runs, KeyCode::Up | KeyCode::Char('k')) => runs.move_selection(features, -1),
        (Page::Runs, KeyCode::Down | KeyCode::Char('j')) => runs.move_selection(features, 1),
        (Page::Runs, KeyCode::Enter) if runs.selected.is_none() => {
            runs.open_templates(features, directory)
        }
        (Page::Runs, KeyCode::Char('n')) => runs.open_templates(features, directory),
        (Page::Runs, KeyCode::Enter) => runs.reload_selected(features),
        (Page::Runs, KeyCode::Char('p')) => runs.pause(features),
        (Page::Runs, KeyCode::Char('r')) => runs.resume(features),
        (Page::Runs, KeyCode::Char('d')) => runs.drain(features),
        (Page::Runs, KeyCode::Char('a')) => runs.begin_answer(),
        (Page::Runs, KeyCode::Char('w')) => runs.toggle_wakes(features),
        (Page::Runs, KeyCode::Char('f')) => runs.toggle_delivery(features),
        (Page::Templates, KeyCode::Up | KeyCode::Char('k')) => {
            runs.move_template(-1);
            Effect::default()
        }
        (Page::Templates, KeyCode::Down | KeyCode::Char('j')) => {
            runs.move_template(1);
            Effect::default()
        }
        (Page::Templates, KeyCode::Enter) => runs.start_selected(features),
        (Page::Templates, KeyCode::Char('r'))
            if runs
                .templates
                .as_ref()
                .is_some_and(|templates| matches!(templates.load, Load::Failed(_))) =>
        {
            runs.open_templates(features, directory)
        }
        _ => {
            outcome.redraw = false;
            Effect::default()
        }
    };
    apply(app, outcome, effect);
}

fn answer_key(
    runs: &mut Runs,
    features: &serde_json::Value,
    key: KeyEvent,
    outcome: &mut Outcome,
) -> Effect {
    if key.code == KeyCode::Enter {
        return runs.submit_answer(features);
    }
    if key.code == KeyCode::Esc {
        runs.back();
        return Effect::notice(String::new());
    }
    let Some(form) = runs.answer.as_mut() else {
        return Effect::default();
    };
    match key.code {
        KeyCode::Backspace => {
            form.text.pop();
        }
        KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => form.text.clear(),
        KeyCode::Char(character)
            if !key
                .modifiers
                .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
        {
            form.text.push(character)
        }
        _ => outcome.redraw = false,
    }
    Effect::default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runs::tests as fixtures;
    use ratatui::layout::Rect;
    use serde_json::{Value, json};

    fn press(app: &mut App, code: KeyCode) -> Outcome {
        crate::controller::event(
            app,
            Event::Key(KeyEvent::new(code, KeyModifiers::NONE)),
            Rect::new(0, 0, 150, 44),
        )
    }

    fn app() -> App {
        let mut app = App::new(9);
        let mut capabilities = fixtures::features();
        capabilities["type"] = "capabilities".into();
        capabilities["workspace"] = "C:/Projects/nesvo".into();
        capabilities["programs"] = json!([{"id":"claude","available":true}]);
        app.event(capabilities).unwrap();
        app.dialog = None;
        app.notice.clear();
        app
    }

    fn reply(app: &mut App, command: &Value, mut body: Value) -> Vec<Value> {
        if body.get("type").is_none() {
            body["type"] = "workflow".into();
        }
        body["requestId"] = command["requestId"].clone();
        app.event(body).unwrap()
    }

    fn opened() -> App {
        let mut app = app();
        let list = press(&mut app, KeyCode::Char('W')).commands.remove(0);
        assert_eq!(list["request"]["action"], "list");
        let reads = reply(
            &mut app,
            &list,
            json!({"runs":fixtures::listed(),"nextOffset":null}),
        );
        for command in reads {
            let body = match command["request"]["action"].as_str() {
                Some("get") => fixtures::view(),
                Some("decision") => json!({"decisions":fixtures::decisions(),"nextOffset":null}),
                Some("digest") => fixtures::digest(),
                _ => fixtures::inbox(),
            };
            reply(&mut app, &command, body);
        }
        app
    }

    #[test]
    fn runs_view_opens_from_navigation_and_esc_keeps_the_snapshot_for_the_leaf() {
        let mut app = opened();
        assert!(engaged(&app));
        assert_eq!(app.runs.as_ref().unwrap().runs.len(), 2);
        assert!(press(&mut app, KeyCode::Char('j')).commands.len() == 4);
        press(&mut app, KeyCode::Esc);
        assert!(!engaged(&app));
        assert!(app.runs.is_some());
        let reopened = press(&mut app, KeyCode::Char('W'));
        assert!(engaged(&app));
        assert_eq!(reopened.commands[0]["request"]["action"], "list");
        let mut legacy = App::new(3);
        legacy
            .event(json!({"type":"capabilities","workspace":"C:/x","programs":[]}))
            .unwrap();
        legacy.dialog = None;
        press(&mut legacy, KeyCode::Char('W'));
        assert!(legacy.runs.is_none());
        assert!(legacy.notice.contains("Update the host"));
    }

    #[test]
    fn runs_keys_send_pause_resume_drain_and_answer_through_existing_commands() {
        let mut app = opened();
        assert!(press(&mut app, KeyCode::Char('p')).commands.is_empty());
        assert!(app.notice.contains("Press p again"));
        let pause = press(&mut app, KeyCode::Char('p')).commands.remove(0);
        assert_eq!(pause["request"]["request"]["kind"], "stop");
        reply(&mut app, &pause, json!({"run":{"id":"run-a"}}));
        assert!(press(&mut app, KeyCode::Char('p')).commands.is_empty());
        assert!(press(&mut app, KeyCode::Char('x')).commands.is_empty());
        assert!(!app.notice.contains("Press p again"));
        let drain = press(&mut app, KeyCode::Char('d')).commands.remove(0);
        assert_eq!(drain["request"]["action"], "drain");
        reply(&mut app, &drain, json!({"run":{"id":"run-a"}}));
        let resume = press(&mut app, KeyCode::Char('r')).commands.remove(0);
        assert_eq!(resume["request"]["action"], "resume");
        reply(&mut app, &resume, json!({"run":{"id":"run-a"}}));
        press(&mut app, KeyCode::Char('a'));
        assert_eq!(app.runs.as_ref().unwrap().page, Page::Answer);
        for character in "Yes".chars() {
            press(&mut app, KeyCode::Char(character));
        }
        crate::controller::event(
            &mut app,
            Event::Paste(" go".into()),
            Rect::new(0, 0, 150, 44),
        );
        press(&mut app, KeyCode::Backspace);
        let answer = press(&mut app, KeyCode::Enter).commands.remove(0);
        assert_eq!(answer["request"]["request"]["answer"], "Yes g");
        assert_eq!(answer["request"]["request"]["decisionId"], "d2");
    }

    #[test]
    fn runs_w_and_f_send_owner_wake_commands_for_the_selected_run() {
        let mut app = app();
        let mut capabilities = fixtures::wake_features();
        capabilities["type"] = "capabilities".into();
        capabilities["workspace"] = "C:/Projects/nesvo".into();
        capabilities["programs"] = json!([{"id":"claude","available":true}]);
        app.event(capabilities).unwrap();
        app.dialog = None;
        let list = press(&mut app, KeyCode::Char('W')).commands.remove(0);
        let reads = reply(
            &mut app,
            &list,
            json!({"runs":fixtures::listed(),"nextOffset":null}),
        );
        assert_eq!(reads.len(), 5);
        for command in reads {
            let body = match command["request"]["action"].as_str() {
                Some("get") => fixtures::view(),
                Some("decision") => json!({"decisions":fixtures::decisions(),"nextOffset":null}),
                Some("wakes") => fixtures::wakes(),
                Some("digest") => fixtures::digest(),
                _ => fixtures::inbox(),
            };
            reply(&mut app, &command, body);
        }
        let hold = press(&mut app, KeyCode::Char('w')).commands.remove(0);
        assert_eq!(hold["request"]["action"], "wakes");
        assert_eq!(hold["request"]["request"]["action"], "pause");
        assert_eq!(hold["request"]["request"]["expectedRevision"], 4);
        let after = reply(&mut app, &hold, json!({"run":{"id":"run-a"}}));
        assert!(app.notice.contains("held"));
        assert_eq!(after[0]["request"]["action"], "list");
        let full = press(&mut app, KeyCode::Char('f')).commands.remove(0);
        assert_eq!(full["request"]["request"]["action"], "setDelivery");
        assert_eq!(full["request"]["request"]["delivery"], "full");
    }

    #[test]
    fn runs_template_row_lists_approved_templates_for_the_workspace_and_starts_one() {
        let mut app = opened();
        press(&mut app, KeyCode::Char('k'));
        assert_eq!(app.runs.as_ref().unwrap().selected, None);
        let list = press(&mut app, KeyCode::Enter).commands.remove(0);
        assert_eq!(
            list,
            json!({"type":"listWorkflowTemplates","directory":"C:/Projects/nesvo","requestId":list["requestId"]})
        );
        reply(&mut app, &list, fixtures::templates());
        let start = press(&mut app, KeyCode::Enter).commands.remove(0);
        assert_eq!(start["type"], "startWorkflowTemplate");
        assert_eq!(start["name"], "review");
        assert_eq!(start["directory"], "C:/Projects/nesvo");
        reply(
            &mut app,
            &start,
            json!({"type":"workflowTemplateStarted","run":{"id":"run-c","title":"Branch review"}}),
        );
        assert_eq!(app.runs.as_ref().unwrap().page, Page::Runs);
        assert!(app.notice.contains("Started template review"));
    }
}
