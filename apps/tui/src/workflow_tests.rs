//! Cross-component regressions. All session and diff data here are explicit fixtures.
use crate::{
    controller,
    launch::{Field, Program, SessionForm},
    model::{App, Dialog, Mode},
    review, toolbox, ui,
};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use ratatui::{Terminal, backend::TestBackend, layout::Rect};
use serde_json::json;

fn app() -> App {
    let mut app = App::new(1);
    app.event(json!({"type":"capabilities","workspace":"/repo","gitDiff":true,"advancedLaunch":true,"schedules":true,"quotaWake":true,"programs":[{"id":"claude","available":true},{"id":"shell","available":true}]})).unwrap();
    app.event(json!({"type":"sessions","revision":1,"groups":[{"id":"g","name":"工程","parentId":null,"order":0}],"sessions":[
        {"id":"a","name":"API review","cwd":"/repo","program":"claude","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null,"status":{"state":"working","source":"screen","updatedAt":1}},
        {"id":"b","name":"工具 👩‍💻","cwd":"/repo","program":"codex","cols":80,"rows":24,"running":true,"groupId":"g","controllerId":null,"status":{"state":"blocked","source":"screen","updatedAt":2}}
    ]})).unwrap();
    app
}
fn key(app: &mut App, key: KeyCode) -> controller::Outcome {
    controller::event(
        app,
        Event::Key(KeyEvent::new(key, KeyModifiers::NONE)),
        Rect::new(0, 0, 150, 44),
    )
}
fn data() -> review::ReviewData {
    serde_json::from_value(json!({"files":[{"path":"src/工程.rs","status":"M","patch":"--- a/src/工程.rs\n+++ b/src/工程.rs\n@@ -1,2 +1,1 @@\n-old\n-extra\n+new\n@@ -10 +9 @@\n context\n-end\n+done\n","additions":2,"deletions":3,"truncated":false}],"truncated":false})).unwrap()
}

#[test]
fn expansion_keeps_query_and_highlight_never_releases_active_lease() {
    let mut app = app();
    app.leases.insert("a".into(), "lease".into());
    key(&mut app, KeyCode::Char('/'));
    key(&mut app, KeyCode::Char('工'));
    let outcome = key(&mut app, KeyCode::F(2));
    assert!(app.palette_expanded);
    assert!(matches!(&app.dialog, Some(Dialog::QuickSwitch { query, .. }) if query == "工"));
    assert_eq!(app.active_id(), Some("a"));
    assert!(app.leases.contains_key("a"));
    assert!(
        !outcome
            .commands
            .iter()
            .any(|c| c["type"] == "releaseControl" || c["type"] == "acquireControl")
    );
    key(&mut app, KeyCode::Esc);
    assert_eq!(app.active_id(), Some("a"));
}

#[test]
fn diff_rejects_stale_responses_preserves_hunks_and_falls_back_on_old_host() {
    let mut app = app();
    let first = app.request_diff().unwrap();
    let second = app.request_diff().unwrap();
    app.event(
        json!({"type":"diff","sessionId":"a","requestId":first["requestId"],"error":"stale"}),
    )
    .unwrap();
    assert!(app.review.error.is_none());
    assert_eq!(
        app.review.request_id.as_deref(),
        second["requestId"].as_str()
    );
    app.review.accept(data());
    app.review.toggle_hunk();
    app.review.hunk = 1;
    app.review.toggle_hunk();
    app.review.accept(data());
    assert_eq!(app.review.folded.len(), 2);
    app.review.toggle_hunk();
    assert_eq!(app.review.folded.len(), 1);
    app.capabilities.as_mut().unwrap().git_diff = false;
    assert!(app.request_diff().is_none());
    assert!(
        app.review
            .error
            .as_ref()
            .unwrap()
            .contains("does not support")
    );
}

#[test]
fn scheduled_launch_keeps_prompt_and_worktree_and_footer_returns_to_fields() {
    let mut app = app();
    app.dialog = Some(Dialog::NewSession(SessionForm {
        name: "Later".into(),
        program: Program::Claude,
        prompt: "Review this change".into(),
        when: "16:02".into(),
        worktree: true,
        advanced: true,
        field: Field::When,
        ..Default::default()
    }));
    key(&mut app, KeyCode::Tab);
    assert_eq!(app.dialog_button, Some(0));
    key(&mut app, KeyCode::Up);
    assert!(matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.field == Field::When));
    let outcome = key(&mut app, KeyCode::Enter);
    assert_eq!(outcome.commands[0]["type"], "scheduleSession");
    assert_eq!(outcome.commands[0]["spec"]["prompt"], "Review this change");
    assert_eq!(outcome.commands[0]["spec"]["worktree"], true);
    assert_eq!(outcome.commands[0]["at"], "16:02");
}

#[test]
fn selectable_filters_do_not_switch_active_session_and_modal_consumes_input() {
    let mut app = app();
    key(&mut app, KeyCode::Char('f'));
    key(&mut app, KeyCode::Down);
    key(&mut app, KeyCode::Down);
    key(&mut app, KeyCode::Down);
    key(&mut app, KeyCode::Char(' '));
    assert_eq!(app.quick_switch_results("").len(), 1);
    assert_eq!(app.active_id(), Some("a"));
    assert!(key(&mut app, KeyCode::Char('n')).commands.is_empty());
    assert!(app.dialog.is_none());
    key(&mut app, KeyCode::Esc);
    assert!(app.overlay.is_none());
}

#[test]
fn real_renderer_handles_review_and_modals_at_required_sizes() {
    let mut app = app();
    app.review.visible = true;
    app.review.session_id = "a".into();
    app.review.focused = true;
    app.review.accept(data());
    for (width, height) in [(80, 24), (100, 32), (150, 44), (8, 4)] {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| ui::render(frame, &app, 0)).unwrap();
        let layout = ui::geometry(Rect::new(0, 0, width, height), &app);
        assert!(layout.review.right() <= width && layout.review.bottom() <= height);
        if width < 140 {
            assert!(layout.panes[0].is_empty());
        } else {
            assert!(layout.panes[0].width >= 60);
        }
        for overlay in [
            toolbox::Overlay::Filters(3),
            toolbox::Overlay::Onboarding(2),
            toolbox::Overlay::Schedules(0),
        ] {
            app.overlay = Some(overlay);
            terminal.draw(|frame| ui::render(frame, &app, 0)).unwrap();
        }
        app.overlay = None;
    }
    app.mode = Mode::Input;
    let result = key(&mut app, KeyCode::Char('D'));
    assert!(!result.commands.iter().any(|c| c["type"] == "getDiff"));
}
