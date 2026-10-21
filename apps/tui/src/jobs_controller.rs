use crate::{
    controller::Outcome,
    jobs::{Effect, FormField, Jobs, Load, Page},
    launch::Program,
    model::App,
};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

fn agents(app: &App) -> Vec<Program> {
    app.capabilities.as_ref().map_or_else(Vec::new, |caps| {
        Program::ALL
            .into_iter()
            .filter(|program| *program != Program::Shell && caps.available(*program))
            .collect()
    })
}

pub fn tick(app: &mut App) -> bool {
    app.jobs.as_mut().is_some_and(|jobs| jobs.tick(now_ms()))
}

pub fn open(app: &mut App, outcome: &mut Outcome) {
    match Jobs::open(app.client_id, &app.host_features, now_ms()) {
        Ok((jobs, command)) => {
            app.jobs = Some(jobs);
            app.notice.clear();
            outcome.commands.push(command);
        }
        Err(_) => app.notice = "Update the host to manage durable jobs.".into(),
    }
}

pub fn host_event(app: &mut App, event: &serde_json::Value) -> Vec<serde_json::Value> {
    let Some(jobs) = app.jobs.as_mut() else {
        return Vec::new();
    };
    let effect = if event["type"] == "error" {
        jobs.failure(&app.host_features, event)
    } else {
        jobs.response(&app.host_features, event, now_ms())
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
            if let Some(field) = app
                .jobs
                .as_mut()
                .and_then(|jobs| jobs.form.as_mut())
                .and_then(|form| form.text_mut())
            {
                field.push_str(&text.replace(['\r', '\n'], " "));
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
    let Some(jobs) = app.jobs.as_ref() else {
        return;
    };
    if jobs.page == Page::Form {
        return form_key(app, key, outcome);
    }
    if key.code == KeyCode::Esc {
        return back(app);
    }
    let programs = agents(app);
    let folder = app
        .capabilities
        .as_ref()
        .map(|caps| caps.workspace.clone())
        .unwrap_or_default();
    let features = &app.host_features;
    let Some(jobs) = app.jobs.as_mut() else {
        return;
    };
    let effect = match (&jobs.load, jobs.page, key.code) {
        (Load::Ready, Page::Definitions, KeyCode::Char('r'))
        | (Load::Failed(_), _, KeyCode::Char('r')) => jobs.refresh(features),
        (Load::Ready, Page::Definitions, KeyCode::Up | KeyCode::Char('k')) => {
            jobs.move_selection(features, -1)
        }
        (Load::Ready, Page::Definitions, KeyCode::Down | KeyCode::Char('j')) => {
            jobs.move_selection(features, 1)
        }
        (Load::Ready, Page::Definitions, KeyCode::Enter) => jobs.open_detail(features),
        (Load::Ready, Page::Definitions, KeyCode::Char('n')) => {
            jobs.new_form(programs, folder);
            Effect::default()
        }
        (Load::Ready, Page::Detail, KeyCode::Char('e')) => jobs.edit_form(programs),
        (Load::Ready, Page::Detail, KeyCode::Char(' ')) => jobs.toggle_enabled(features),
        (Load::Ready, Page::Detail, KeyCode::Char('R')) => jobs.run_now(features),
        (Load::Ready, Page::Detail, KeyCode::Char('h')) => jobs.open_history(features),
        (Load::Ready, Page::History, KeyCode::Up | KeyCode::Char('k')) => {
            jobs.move_occurrence(-1);
            Effect::default()
        }
        (Load::Ready, Page::History, KeyCode::Down | KeyCode::Char('j')) => {
            jobs.move_occurrence(1);
            Effect::default()
        }
        (Load::Ready, Page::History, KeyCode::Enter) => jobs.inspect_occurrence(features),
        (Load::Ready, Page::History, KeyCode::Char('c')) => jobs.cancel_occurrence(features),
        _ => {
            outcome.redraw = false;
            Effect::default()
        }
    };
    apply(app, outcome, effect);
}

fn back(app: &mut App) {
    let Some(jobs) = app.jobs.as_mut() else {
        return;
    };
    match (&jobs.load, jobs.page) {
        (Load::Ready, Page::History) => jobs.page = Page::Detail,
        (Load::Ready, Page::Detail) => jobs.page = Page::Definitions,
        _ => {
            app.jobs = None;
            app.notice.clear();
        }
    }
}

fn form_key(app: &mut App, key: KeyEvent, outcome: &mut Outcome) {
    let features = &app.host_features;
    let Some(jobs) = app.jobs.as_mut() else {
        return;
    };
    match key.code {
        KeyCode::Esc => {
            jobs.discard_form();
            app.notice.clear();
        }
        KeyCode::Enter => {
            let effect = jobs.save_form(features);
            apply(app, outcome, effect);
        }
        code => {
            let Some(form) = jobs.form.as_mut() else {
                return;
            };
            match code {
                KeyCode::Tab | KeyCode::Down => form.step(true),
                KeyCode::BackTab | KeyCode::Up => form.step(false),
                KeyCode::Left if form.field == FormField::Schedule => form.cycle_kind(false),
                KeyCode::Right | KeyCode::Char(' ') if form.field == FormField::Schedule => {
                    form.cycle_kind(true)
                }
                KeyCode::Left if form.field == FormField::Agent => form.cycle_program(false),
                KeyCode::Right | KeyCode::Char(' ') if form.field == FormField::Agent => {
                    form.cycle_program(true)
                }
                KeyCode::Backspace => {
                    if let Some(text) = form.text_mut() {
                        text.pop();
                    }
                }
                KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    if let Some(text) = form.text_mut() {
                        text.clear();
                    }
                }
                KeyCode::Char(character)
                    if !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
                {
                    if let Some(text) = form.text_mut() {
                        text.push(character);
                    }
                }
                _ => outcome.redraw = false,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::tests as fixtures;
    use crossterm::event::KeyEvent;
    use ratatui::layout::Rect;
    use serde_json::json;

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
        capabilities["programs"] = json!([
            {"id":"claude","available":true},
            {"id":"gemini","available":false},
            {"id":"codex","available":true}
        ]);
        app.event(capabilities).unwrap();
        app.dialog = None;
        app.notice.clear();
        app
    }

    fn reply(
        app: &mut App,
        command: &serde_json::Value,
        body: serde_json::Value,
    ) -> Vec<serde_json::Value> {
        let mut event = body;
        event["type"] = "workflow".into();
        event["requestId"] = command["requestId"].clone();
        app.event(event).unwrap()
    }

    fn opened() -> App {
        let mut app = app();
        let list = press(&mut app, KeyCode::Char('J')).commands.remove(0);
        let get = reply(
            &mut app,
            &list,
            json!({"jobs":fixtures::definitions(),"nextOffset":null}),
        )
        .remove(0);
        reply(&mut app, &get, json!({"job":fixtures::detail()}));
        app
    }

    #[test]
    fn capital_j_opens_jobs_and_unsupported_hosts_stay_in_navigation() {
        let mut legacy = App::new(9);
        legacy
            .event(json!({"type":"capabilities","workspace":"/w","programs":[]}))
            .unwrap();
        legacy.dialog = None;
        assert!(press(&mut legacy, KeyCode::Char('J')).commands.is_empty());
        assert!(legacy.jobs.is_none());
        assert!(legacy.notice.contains("Update the host"));

        let mut app = app();
        let outcome = press(&mut app, KeyCode::Char('J'));
        assert_eq!(outcome.commands[0]["request"]["action"], "jobs");
        assert_eq!(outcome.commands[0]["request"]["request"]["action"], "list");
        assert!(app.jobs.is_some());
    }

    #[test]
    fn jobs_view_owns_keys_and_escape_steps_back_to_navigation() {
        let mut app = opened();
        assert_eq!(app.jobs.as_ref().unwrap().load, Load::Ready);
        let down = press(&mut app, KeyCode::Down);
        assert_eq!(down.commands[0]["request"]["request"]["jobId"], "nightly");
        assert_eq!(app.selected, 0);
        press(&mut app, KeyCode::Up);
        let detail = press(&mut app, KeyCode::Enter);
        assert_eq!(app.jobs.as_ref().unwrap().page, Page::Detail);
        assert_eq!(detail.commands[0]["request"]["request"]["action"], "get");
        let history = press(&mut app, KeyCode::Char('h'));
        assert_eq!(app.jobs.as_ref().unwrap().page, Page::History);
        assert_eq!(
            history.commands[0]["request"]["request"]["action"],
            "history"
        );
        press(&mut app, KeyCode::Esc);
        assert_eq!(app.jobs.as_ref().unwrap().page, Page::Detail);
        press(&mut app, KeyCode::Esc);
        assert_eq!(app.jobs.as_ref().unwrap().page, Page::Definitions);
        assert!(press(&mut app, KeyCode::Char('n')).commands.is_empty());
        assert!(app.dialog.is_none());
        assert_eq!(app.jobs.as_ref().unwrap().page, Page::Form);
        press(&mut app, KeyCode::Esc);
        press(&mut app, KeyCode::Esc);
        assert!(app.jobs.is_none());
        assert!(app.mode == crate::model::Mode::Navigate);
    }

    #[test]
    fn form_typing_cycles_installed_agents_and_saves_through_the_host() {
        let mut app = opened();
        press(&mut app, KeyCode::Char('n'));
        for character in "Nightly".chars() {
            press(&mut app, KeyCode::Char(character));
        }
        press(&mut app, KeyCode::Tab);
        press(&mut app, KeyCode::Right);
        let form = app.jobs.as_ref().unwrap().form.as_ref().unwrap();
        assert_eq!(form.programs, [Program::Claude, Program::Codex]);
        assert_eq!(form.program, Program::Codex);
        assert_eq!(form.folder, "C:/Projects/nesvo");
        press(&mut app, KeyCode::Tab);
        press(&mut app, KeyCode::Tab);
        crate::controller::event(
            &mut app,
            Event::Paste("Check\nthe build".into()),
            Rect::new(0, 0, 150, 44),
        );
        press(&mut app, KeyCode::Tab);
        assert_eq!(
            app.jobs.as_ref().unwrap().form.as_ref().unwrap().field,
            FormField::Schedule
        );
        press(&mut app, KeyCode::Tab);
        for character in "2026-10-22 16:02 +02:00".chars() {
            press(&mut app, KeyCode::Char(character));
        }
        let save = press(&mut app, KeyCode::Enter);
        let request = &save.commands[0]["request"]["request"];
        assert_eq!(request["action"], "create");
        assert_eq!(request["spec"]["title"], "Nightly");
        assert_eq!(request["spec"]["instruction"], "Check the build");
        let mut created = fixtures::detail();
        created["id"] = "created".into();
        created["title"] = "Nightly".into();
        let follow_up = reply(&mut app, &save.commands[0], json!({"job":created}));
        let jobs = app.jobs.as_ref().unwrap();
        assert_eq!(jobs.page, Page::Detail);
        assert_eq!(jobs.selected.as_deref(), Some("created"));
        assert!(jobs.form.is_none());
        assert!(app.notice.contains("saved"));
        assert_eq!(follow_up[0]["request"]["request"]["action"], "list");
    }

    #[test]
    fn schedule_field_cycles_kinds_and_saves_a_cron_job() {
        let mut app = opened();
        press(&mut app, KeyCode::Char('n'));
        for character in "Weekdays".chars() {
            press(&mut app, KeyCode::Char(character));
        }
        for _ in 0..3 {
            press(&mut app, KeyCode::Tab);
        }
        for character in "Review".chars() {
            press(&mut app, KeyCode::Char(character));
        }
        press(&mut app, KeyCode::Tab);
        press(&mut app, KeyCode::Char('x'));
        press(&mut app, KeyCode::Right);
        let form = app.jobs.as_ref().unwrap().form.as_ref().unwrap();
        assert_eq!(form.kind, crate::jobs::ScheduleKind::Cron);
        assert_eq!(form.title, "Weekdays");
        press(&mut app, KeyCode::Left);
        press(&mut app, KeyCode::Char(' '));
        press(&mut app, KeyCode::Tab);
        assert_eq!(
            app.jobs.as_ref().unwrap().form.as_ref().unwrap().field,
            FormField::Expression
        );
        for character in "0 9 * * 1-5".chars() {
            press(&mut app, KeyCode::Char(character));
        }
        let save = press(&mut app, KeyCode::Enter);
        assert_eq!(
            save.commands[0]["request"]["request"]["spec"]["schedule"],
            json!({"kind":"cron","expression":"0 9 * * 1-5","timeZone":"Europe/Warsaw"})
        );
    }

    #[test]
    fn host_errors_reach_the_jobs_view_and_disconnect_reports_unconfirmed_changes() {
        let mut app = opened();
        press(&mut app, KeyCode::Enter);
        let pause = press(&mut app, KeyCode::Char(' ')).commands.remove(0);
        let key = pause["request"]["request"]["key"]
            .as_str()
            .unwrap()
            .to_owned();
        let follow_up = app
            .event(json!({"type":"error","requestId":pause["requestId"],"code":"revision_conflict","message":"stale"}))
            .unwrap();
        assert!(app.notice.contains("changed on the host"));
        assert!(
            follow_up
                .iter()
                .any(|command| command["request"]["request"]["action"] == "get")
        );
        let run = press(&mut app, KeyCode::Char('R')).commands.remove(0);
        let run_key = run["request"]["request"]["key"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(run_key, key);
        app.disconnect("Host connection lost".into());
        assert!(app.jobs.is_none());
        assert!(app.notice.contains(&run_key));
    }

    #[test]
    fn redraw_tick_refreshes_the_jobs_clock() {
        let mut app = opened();
        app.jobs.as_mut().unwrap().now_ms = 0;
        assert!(app.refresh_session_times(std::time::Instant::now()));
        assert!(app.jobs.as_ref().unwrap().now_ms > 0);
        assert!(!tick(&mut App::new(9)));
    }

    #[test]
    fn list_failure_shows_the_error_page_and_r_retries_the_read() {
        let mut app = app();
        let list = press(&mut app, KeyCode::Char('J')).commands.remove(0);
        app.event(json!({"type":"error","requestId":list["requestId"],"code":"busy","message":"Host is busy"}))
            .unwrap();
        assert_eq!(
            app.jobs.as_ref().unwrap().load,
            Load::Failed("Host is busy".into())
        );
        assert!(app.notice.is_empty());
        let retry = press(&mut app, KeyCode::Char('r'));
        assert_eq!(retry.commands[0]["request"]["request"]["action"], "list");
        assert_eq!(app.jobs.as_ref().unwrap().load, Load::Loading);
    }
}
