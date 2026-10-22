use crate::{
    controller::Outcome,
    key_table::{self, Binding, bind, plain, unlisted},
    layouts::Role,
    model::App,
    runs::{ANSWER_BYTES, Effect, Load, Page, Runs},
};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use nesvo_wire::views::ReplyHeader;
use serde_json::Value;
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunKey {
    Previous,
    Next,
    Templates,
    Reload,
    Pause,
    Resume,
    Drain,
    Answer,
    Wakes,
    Delivery,
    Refresh,
    Start,
    Retry,
    Submit,
    Back,
}

const MOVE: [Binding<RunKey>; 2] = [
    bind(
        &[plain(KeyCode::Up), plain(KeyCode::Char('k'))],
        "↑↓",
        "select",
        RunKey::Previous,
    ),
    unlisted(
        &[plain(KeyCode::Down), plain(KeyCode::Char('j'))],
        RunKey::Next,
    ),
];
const BACK: Binding<RunKey> = bind(&[plain(KeyCode::Esc)], "Esc", "back", RunKey::Back);
const ANSWER_KEYS: [Binding<RunKey>; 2] = [
    bind(&[plain(KeyCode::Enter)], "Enter", "answer", RunKey::Submit),
    bind(&[plain(KeyCode::Esc)], "Esc", "cancel", RunKey::Back),
];
const RUN_CONTROLS: [Binding<RunKey>; 5] = [
    bind(&[plain(KeyCode::Enter)], "Enter", "reload", RunKey::Reload),
    bind(&[plain(KeyCode::Char('p'))], "p", "pause", RunKey::Pause),
    bind(&[plain(KeyCode::Char('r'))], "r", "resume", RunKey::Resume),
    bind(&[plain(KeyCode::Char('d'))], "d", "drain", RunKey::Drain),
    bind(&[plain(KeyCode::Char('a'))], "a", "answer", RunKey::Answer),
];
const WAKE_CONTROLS: [Binding<RunKey>; 2] = [
    bind(&[plain(KeyCode::Char('w'))], "w", "wakes", RunKey::Wakes),
    bind(
        &[plain(KeyCode::Char('f'))],
        "f",
        "delivery",
        RunKey::Delivery,
    ),
];

const RELOAD_TEMPLATES: Binding<RunKey> =
    bind(&[plain(KeyCode::F(5))], "F5", "reload", RunKey::Refresh);
const REFRESH_RUNS: Binding<RunKey> =
    bind(&[plain(KeyCode::F(5))], "F5", "refresh", RunKey::Refresh);
const START: Binding<RunKey> = bind(&[plain(KeyCode::Enter)], "Enter", "start", RunKey::Start);
const RETRY: Binding<RunKey> = bind(&[plain(KeyCode::Char('r'))], "r", "retry", RunKey::Retry);
const OPEN_TEMPLATES: Binding<RunKey> = bind(
    &[plain(KeyCode::Enter), plain(KeyCode::Char('n'))],
    "Enter n",
    "templates",
    RunKey::Templates,
);
const NEW_FROM_TEMPLATE: Binding<RunKey> = bind(
    &[plain(KeyCode::Char('n'))],
    "n",
    "template",
    RunKey::Templates,
);

pub fn keys(runs: &Runs) -> Vec<Binding<RunKey>> {
    let mut keys = Vec::new();
    match runs.page {
        Page::Answer => keys.extend(ANSWER_KEYS),
        Page::Templates => {
            keys.extend(MOVE);
            keys.extend([START, RELOAD_TEMPLATES]);
            if runs
                .templates
                .as_ref()
                .is_some_and(|templates| matches!(templates.load, Load::Failed(_)))
            {
                keys.push(RETRY);
            }
            keys.push(BACK);
        }
        Page::Runs if runs.selected.is_none() => {
            keys.extend(MOVE);
            keys.extend([OPEN_TEMPLATES, REFRESH_RUNS, BACK]);
        }
        Page::Runs => {
            keys.extend(MOVE);
            keys.extend(RUN_CONTROLS);
            if runs
                .selected_detail()
                .is_some_and(|detail| detail.wakes.loaded || detail.wakes.error.is_some())
            {
                keys.extend(WAKE_CONTROLS);
            }
            keys.extend([NEW_FROM_TEMPLATE, REFRESH_RUNS, BACK]);
        }
    }
    keys
}

pub fn engaged(app: &App) -> bool {
    app.runs.as_ref().is_some_and(|runs| runs.open)
}

fn watched(app: &App) -> bool {
    engaged(app) || app.pane_tree().position(Role::Runs).is_some()
}

pub fn tick(app: &mut App) -> Option<Value> {
    if !app.connected || !watched(app) {
        return None;
    }
    let features = &app.host_features;
    app.runs.as_mut()?.poll(features)
}

pub fn expire(app: &mut App) -> bool {
    let Some(runs) = app.runs.as_mut() else {
        return false;
    };
    let expiry = runs.expire(Instant::now());
    if let Some(notice) = expiry.notice {
        app.notice = notice;
    }
    expiry.changed
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

pub fn host_event(app: &mut App, event: &Value) -> Vec<Value> {
    let Some(runs) = app.runs.as_mut() else {
        return Vec::new();
    };
    let effect = if ReplyHeader::of(event).kind.as_deref() == Some("error") {
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
                crate::input::append_field(&mut form.text, &text, ANSWER_BYTES);
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
    let action = key_table::action(&keys(runs), &key);
    if runs.page == Page::Answer {
        let effect = answer_key(runs, features, action, key, outcome);
        return apply(app, outcome, effect);
    }
    if action == Some(RunKey::Back) {
        runs.back();
        app.notice.clear();
        return;
    }
    if action != Some(RunKey::Pause) && runs.cancel_confirm() {
        app.notice.clear();
    }
    let effect = match action {
        Some(RunKey::Refresh) => runs.refresh(features),
        Some(RunKey::Previous) if runs.page == Page::Templates => {
            runs.move_template(-1);
            Effect::default()
        }
        Some(RunKey::Next) if runs.page == Page::Templates => {
            runs.move_template(1);
            Effect::default()
        }
        Some(RunKey::Previous) => runs.move_selection(features, -1),
        Some(RunKey::Next) => runs.move_selection(features, 1),
        Some(RunKey::Templates | RunKey::Retry) => runs.open_templates(features, directory),
        Some(RunKey::Reload) => runs.reload_selected(features),
        Some(RunKey::Pause) => runs.pause(features),
        Some(RunKey::Resume) => runs.resume(features),
        Some(RunKey::Drain) => runs.drain(features),
        Some(RunKey::Answer) => runs.begin_answer(),
        Some(RunKey::Wakes) => runs.toggle_wakes(features),
        Some(RunKey::Delivery) => runs.toggle_delivery(features),
        Some(RunKey::Start) => runs.start_selected(features),
        Some(RunKey::Submit | RunKey::Back) | None => {
            outcome.redraw = false;
            Effect::default()
        }
    };
    apply(app, outcome, effect);
}

fn answer_key(
    runs: &mut Runs,
    features: &Value,
    action: Option<RunKey>,
    key: KeyEvent,
    outcome: &mut Outcome,
) -> Effect {
    match action {
        Some(RunKey::Submit) => return runs.submit_answer(features),
        Some(RunKey::Back) => {
            runs.back();
            return Effect::notice(String::new());
        }
        _ => {}
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
            crate::input::append_field(&mut form.text, &character.to_string(), ANSWER_BYTES);
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
    fn runs_keys_come_from_one_table_per_page() {
        let line = |runs: &Runs| {
            let keys = keys(runs);
            crate::key_table::assert_unambiguous(&keys);
            crate::key_table::line(&keys)
        };
        let mut runs = fixtures::loaded();
        assert_eq!(
            line(&runs),
            "↑↓ select · Enter reload · p pause · r resume · d drain · a answer · n template · F5 refresh · Esc back"
        );
        assert!(line(&fixtures::loaded_with_wakes()).contains("w wakes · f delivery"));
        runs.selected = None;
        assert_eq!(
            line(&runs),
            "↑↓ select · Enter n templates · F5 refresh · Esc back"
        );
        runs.page = Page::Answer;
        assert_eq!(line(&runs), "Enter answer · Esc cancel");
        runs.page = Page::Templates;
        assert_eq!(
            line(&runs),
            "↑↓ select · Enter start · F5 reload · Esc back"
        );
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

    #[test]
    fn runs_answer_typing_and_paste_drop_controls_and_stop_at_the_host_cap() {
        let mut app = opened();
        press(&mut app, KeyCode::Char('a'));
        crate::controller::event(
            &mut app,
            Event::Paste("a\u{7}b\r\nc\u{1b}".into()),
            Rect::new(0, 0, 150, 44),
        );
        assert_eq!(
            app.runs.as_ref().unwrap().answer.as_ref().unwrap().text,
            "ab  c"
        );
        crate::controller::event(
            &mut app,
            Event::Paste("x".repeat(ANSWER_BYTES * 2)),
            Rect::new(0, 0, 150, 44),
        );
        press(&mut app, KeyCode::Char('y'));
        let text = &app.runs.as_ref().unwrap().answer.as_ref().unwrap().text;
        assert_eq!(text.len(), ANSWER_BYTES);
        assert!(!text.ends_with('y'));
    }

    #[test]
    fn runs_poll_only_while_the_view_or_a_runs_leaf_is_shown() {
        let mut app = opened();
        app.connected = true;
        let age = |app: &mut App| app.runs.as_mut().unwrap().age_poll();
        age(&mut app);
        let poll = tick(&mut app).unwrap();
        assert_eq!(poll["request"]["action"], "list");
        assert!(tick(&mut app).is_none());
        reply(
            &mut app,
            &poll,
            json!({"runs":fixtures::listed(),"nextOffset":null}),
        );
        press(&mut app, KeyCode::Esc);
        assert!(!engaged(&app));
        age(&mut app);
        assert!(tick(&mut app).is_none());
        app.set_pane_layout(crate::layouts::PaneTree::split(
            crate::layouts::Direction::Horizontal,
            crate::layouts::PaneTree::leaf(Role::Agent),
            crate::layouts::PaneTree::leaf(Role::Runs),
        ));
        assert_eq!(tick(&mut app).unwrap()["request"]["action"], "list");
    }
}
