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

#[test]
fn f4_reviews_without_sidebar_and_restores_terminal_input() {
    let mut app = app();
    app.fullscreen = true;
    app.mode = Mode::Input;
    let result = key(&mut app, KeyCode::F(4));
    assert!(result.commands.iter().any(|c| c["type"] == "getDiff"));
    assert!(app.review.visible && app.review.focused);
    let layout = ui::geometry(Rect::new(0, 0, 150, 44), &app);
    assert_eq!(layout.tree.width, 0);
    assert!(layout.review.width > 0);
    key(&mut app, KeyCode::Esc);
    assert!(!app.review.visible);
    assert!(app.mode == Mode::Input);
    key(&mut app, KeyCode::F(4));
    key(&mut app, KeyCode::F(4));
    assert!(app.mode == Mode::Input && !app.review.visible);
    app.mode = Mode::Navigate;
    key(&mut app, KeyCode::Char('D'));
    assert!(!app.review.visible);
    app.dialog = Some(Dialog::Help { from_menu: false });
    key(&mut app, KeyCode::F(4));
    assert!(!app.review.visible);
}

#[test]
fn diff_refresh_waits_for_previous_response_and_pauses_when_hidden() {
    let mut app = app();
    app.connected = true;
    app.request_diff();
    app.review.last_requested = Some(std::time::Instant::now() - std::time::Duration::from_secs(4));
    assert!(app.auto_refresh_diff().is_none());
    app.review.accept(data());
    app.review.scroll = 7;
    app.review.toggle_hunk();
    app.dialog = Some(Dialog::Help { from_menu: false });
    assert!(app.auto_refresh_diff().is_none());
    app.dialog = None;
    assert!(app.auto_refresh_diff().is_some());
    app.review.accept(data());
    assert_eq!(app.review.scroll, 7);
    assert!(!app.review.folded.is_empty());
    assert!(app.auto_refresh_diff().is_none());
    app.review.last_requested = Some(std::time::Instant::now() - std::time::Duration::from_secs(4));
    app.review.visible = false;
    assert!(app.auto_refresh_diff().is_none());
}

#[test]
fn session_click_and_passive_mouse_events_preserve_input() {
    use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
    let mut app = app();
    app.fullscreen = false;
    app.activate_session("a");
    app.event(json!({"type":"control","sessionId":"a","controllerId":1,"cols":80,"rows":24,"leaseId":"owned"})).unwrap();
    assert!(app.mode == Mode::Input);
    let area = Rect::new(0, 0, 150, 44);
    let pane = ui::geometry(area, &app).panes[0];
    let click = controller::event(
        &mut app,
        Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: pane.x + 2,
            row: pane.y + 2,
            modifiers: KeyModifiers::NONE,
        }),
        area,
    );
    assert!(app.mode == Mode::Input);
    assert!(!click.commands.iter().any(|c| c["type"] == "input"
        || c["type"] == "releaseControl"
        || c["type"] == "acquireControl"));
    app.request_diff();
    app.review.focused = false;
    let panel = ui::geometry(area, &app).review;
    for kind in [
        MouseEventKind::Moved,
        MouseEventKind::Up(MouseButton::Left),
        MouseEventKind::Drag(MouseButton::Left),
    ] {
        controller::event(
            &mut app,
            Event::Mouse(MouseEvent {
                kind,
                column: panel.x + 1,
                row: panel.y + 1,
                modifiers: KeyModifiers::NONE,
            }),
            area,
        );
        assert!(app.mode == Mode::Input);
        assert!(!app.review.focused);
    }
    let request = app.review.request_id.clone().unwrap();
    app.event(json!({"type":"diff","sessionId":"a","requestId":request,"review":{"files":[],"truncated":false}})).unwrap();
    app.event(json!({"type":"control","sessionId":"a","controllerId":1,"cols":90,"rows":30,"leaseId":"owned"})).unwrap();
    assert!(app.mode == Mode::Input);
    app.event(json!({"type":"sessions","revision":2,"groups":[],"sessions":[
        {"id":"a","name":"Renamed while typing","cwd":"/repo","cols":90,"rows":30,"running":true,"groupId":null,"controllerId":1}
    ]})).unwrap();
    assert!(app.mode == Mode::Input);
    assert!(app.owns("a"));
    app.event(json!({"type":"control","sessionId":"a","controllerId":2,"cols":90,"rows":30}))
        .unwrap();
    assert!(app.mode == Mode::Navigate);
}

#[test]
fn previous_session_toggles_and_previews_do_not_rewrite_history() {
    let mut app = app();
    app.activate_session("a");
    app.activate_session("b");
    key(&mut app, KeyCode::F(6));
    assert_eq!(app.active_id(), Some("a"));
    key(&mut app, KeyCode::F(6));
    assert_eq!(app.active_id(), Some("b"));
    let history = app.recent_sessions.clone();
    app.preview_session("a");
    assert_eq!(app.recent_sessions, history);
    assert_eq!(
        app.palette_results("")[0].target.session_id(),
        Some("b"),
        "A current blocker outranks MRU even in the active session"
    );
    app.sessions[1].status = app.sessions[0].status.clone();
    assert_eq!(app.palette_results("")[0].target.session_id(), Some("a"));
    app.dialog = Some(Dialog::Help { from_menu: false });
    key(&mut app, KeyCode::F(6));
    assert_eq!(app.active_id(), Some("b"));
}

#[test]
fn attention_queue_uses_unread_events_skips_muted_and_acknowledges_exact_episode() {
    let mut app = app();
    app.sessions[0].attention = Some(crate::model::Attention {
        subject: None,
        source: Some(crate::status::Source::Screen),
        sequence: 2,
        kind: "question".into(),
        at: 5,
        unread: true,
    });
    app.sessions[0].muted = true;
    app.sessions[1].attention = Some(crate::model::Attention {
        subject: None,
        source: Some(crate::status::Source::Screen),
        sequence: 3,
        kind: "limit".into(),
        at: 10,
        unread: true,
    });
    let result = key(&mut app, KeyCode::F(7));
    assert_eq!(app.active_id(), Some("b"));
    assert!(
        result
            .commands
            .iter()
            .any(|c| c["type"] == "acknowledgeAttention"
                && c["sequence"] == 3
                && c["sessionId"] == "b")
    );
}

#[test]
fn remapped_review_key_replaces_default_without_changing_printable_input() {
    let mut app = app();
    assert!(app.shortcuts.assign(0, 10));
    key(&mut app, KeyCode::F(4));
    assert!(!app.review.visible);
    app.mode = Mode::Input;
    key(&mut app, KeyCode::F(10));
    assert!(app.review.visible);
    key(&mut app, KeyCode::F(10));
    assert!(!app.review.visible && app.mode == Mode::Input);
}

#[test]
fn template_opens_editable_form_and_restore_requires_confirmation() {
    let mut app = app();
    app.templates = vec![
        json!({"id":"t","name":"Review","spec":{"name":"Review","cwd":"/repo","program":"claude","prompt":"review changes","worktree":true}}),
    ];
    app.overlay = Some(toolbox::Overlay::Recipes(false, 0));
    let opened = key(&mut app, KeyCode::Enter);
    assert!(opened.commands.is_empty());
    assert!(
        matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.prompt == "review changes" && form.worktree && form.when.is_empty())
    );
    app.dialog = None;
    app.recoveries = vec![json!({"id":"old","state":"saved","spec":{"name":"Prior session"}})];
    app.overlay = Some(toolbox::Overlay::Recipes(true, 0));
    assert!(key(&mut app, KeyCode::Enter).commands.is_empty());
    assert!(
        matches!(&app.dialog, Some(Dialog::Confirm {command,..}) if command["type"] == "restoreSession")
    );
    assert_eq!(app.dialog_button, Some(1));
}

#[test]
fn theme_preview_cancel_and_commit_are_distinct() {
    let mut app = app();
    app.overlay = Some(toolbox::Overlay::Themes(
        0,
        crate::theme::Theme::Ultraviolet,
    ));
    key(&mut app, KeyCode::Down);
    assert_eq!(app.theme, crate::theme::Theme::Graphite);
    key(&mut app, KeyCode::Esc);
    assert_eq!(app.theme, crate::theme::Theme::Ultraviolet);
    app.overlay = Some(toolbox::Overlay::Themes(0, app.theme));
    key(&mut app, KeyCode::Down);
    key(&mut app, KeyCode::Enter);
    assert_eq!(app.theme, crate::theme::Theme::Graphite);
    assert!(app.overlay.is_none());
}

#[test]
fn wheel_over_session_preserves_focus_and_routes_application_mouse() {
    use crossterm::event::{MouseEvent, MouseEventKind};
    let mut app = app();
    app.dialog = None;
    app.sessions[0].controller_id = Some(app.client_id);
    app.leases.insert("a".into(), "lease".into());
    let area = Rect::new(0, 0, 150, 44);
    for mode in [Mode::Navigate, Mode::Input] {
        app.mode = mode;
        let mut terminal = crate::terminal::TerminalState::new(4, 80);
        for n in 0..40 {
            terminal.process(&format!("line {n}\r\n"), false);
        }
        app.terminals.insert("a".into(), terminal);
        let pane = ui::pane_content(ui::geometry(area, &app).panes[0], ui::immersive(&app));
        let wheel = Event::Mouse(MouseEvent {
            kind: MouseEventKind::ScrollUp,
            column: pane.x + 2,
            row: pane.y + 2,
            modifiers: KeyModifiers::NONE,
        });
        let result = controller::event(&mut app, wheel.clone(), area);
        assert!(result.commands.is_empty());
        assert!(app.terminals["a"].screen().scrollback() > 0);
        assert!(app.mode == mode);
        app.terminals
            .get_mut("a")
            .unwrap()
            .process("\x1b[?1049h\x1b[?1000h\x1b[?1006h", false);
        let result = controller::event(&mut app, wheel, area);
        assert_eq!(result.commands[0]["data"], "\x1b[<64;3;3M");
        assert_eq!(result.commands[0]["sessionId"], "a");
        assert!(app.mode == mode);
    }
}

#[test]
fn review_copy_uses_full_patch_without_sending_session_input() {
    let mut app = app();
    app.dialog = None;
    app.mode = Mode::Navigate;
    app.review.visible = true;
    app.review.focused = true;
    app.review.session_id = "a".into();
    app.review.accept(data());
    let result = key(&mut app, KeyCode::Char('y'));
    assert_eq!(
        result.clipboard.as_deref(),
        Some(app.review.data.files[0].patch.as_str())
    );
    assert!(result.commands.is_empty());
}

#[test]
fn control_q_reveals_sidebar_even_after_fullscreen_review() {
    let mut app = app();
    app.dialog = None;
    app.fullscreen = true;
    app.mode = Mode::Input;
    key(&mut app, KeyCode::F(4));
    assert!(ui::immersive(&app));
    let outcome = controller::event(
        &mut app,
        Event::Key(KeyEvent::new(KeyCode::Char('q'), KeyModifiers::CONTROL)),
        Rect::new(0, 0, 150, 44),
    );
    assert!(!ui::immersive(&app));
    assert!(!app.review.focused);
    assert!(ui::geometry(Rect::new(0, 0, 150, 44), &app).tree.width > 0);
    assert!(outcome.commands.iter().all(|c| c["type"] != "input"));
}

#[test]
fn dragging_visible_terminal_text_copies_only_on_release() {
    use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
    let mut app = app();
    app.dialog = None;
    app.mode = Mode::Input;
    app.fullscreen = true;
    let mut terminal = crate::terminal::TerminalState::new(43, 150);
    terminal.process("hello world", false);
    app.terminals.insert("a".into(), terminal);
    let send = |app: &mut App, kind, column| {
        controller::event(
            app,
            Event::Mouse(MouseEvent {
                kind,
                column,
                row: 0,
                modifiers: KeyModifiers::NONE,
            }),
            Rect::new(0, 0, 150, 44),
        )
    };
    assert!(
        send(&mut app, MouseEventKind::Down(MouseButton::Left), 0)
            .clipboard
            .is_none()
    );
    assert!(
        send(&mut app, MouseEventKind::Drag(MouseButton::Left), 4)
            .clipboard
            .is_none()
    );
    let result = send(&mut app, MouseEventKind::Up(MouseButton::Left), 4);
    assert_eq!(result.clipboard.as_deref(), Some("hello"));
    assert!(result.commands.is_empty());
    assert!(app.selection.is_none());
}

#[test]
fn left_bracket_moves_review_boundary_left_from_actual_width() {
    let mut app = app();
    app.dialog = None;
    app.review.visible = true;
    app.review.focused = true;
    let before = ui::geometry(Rect::new(0, 0, 150, 44), &app).review.width;
    key(&mut app, KeyCode::Char('['));
    assert_eq!(app.review.width, before + 8);
    key(&mut app, KeyCode::Char(']'));
    assert_eq!(app.review.width, before);
}

#[test]
fn auto_review_clears_pin_and_repository_change_resets_position() {
    let mut app = app();
    key(&mut app, KeyCode::F(4));
    app.review.focused = true;
    app.review.directory = Some("/pinned".into());
    let outcome = key(&mut app, KeyCode::Char('a'));
    assert!(app.review.directory.is_none());
    assert!(
        outcome
            .commands
            .iter()
            .any(|c| c["type"] == "getDiff" && c["directory"].is_null())
    );
    app.review.data = data();
    app.review.data.directory = Some("/first".into());
    app.review.scroll = 20;
    app.review.hunk = 4;
    app.review.folded.insert(("src/工程.rs".into(), 0));
    let mut next = data();
    next.directory = Some("/second".into());
    app.review.accept(next);
    assert_eq!(app.review.scroll, 0);
    assert_eq!(app.review.hunk, 0);
    assert!(app.review.folded.is_empty());
}

#[test]
fn brackets_resize_sidebar_or_visible_review_without_stealing_input() {
    let mut app = app();
    app.mode = Mode::Navigate;
    let area = Rect::new(0, 0, 150, 44);
    let initial = ui::geometry(area, &app).tree.width;
    key(&mut app, KeyCode::Char(']'));
    assert_eq!(ui::geometry(area, &app).tree.width, initial + 4);
    key(&mut app, KeyCode::Char('['));
    assert_eq!(ui::geometry(area, &app).tree.width, initial);
    let saved = crate::workspace_layout::WorkspaceLayout::capture(&app);
    let mut restored = App::new(2);
    saved.apply(&mut restored);
    assert_eq!(restored.sidebar_width, app.sidebar_width);
    app.review.visible = true;
    app.review.focused = false;
    let sidebar = app.sidebar_width;
    key(&mut app, KeyCode::Char('['));
    assert!(app.review.width > 0);
    assert_eq!(app.sidebar_width, sidebar);
    let review = app.review.width;
    app.mode = Mode::Input;
    app.sessions[0].controller_id = Some(app.client_id);
    app.leases.insert("a".into(), "lease".into());
    app.terminals
        .insert("a".into(), crate::terminal::TerminalState::new(24, 80));
    let outcome = key(&mut app, KeyCode::Char(']'));
    assert_eq!(app.sidebar_width, sidebar);
    assert_eq!(app.review.width, review);
    assert!(
        outcome
            .commands
            .iter()
            .any(|c| c["type"] == "input" && c["data"] == "]")
    );
    app.mode = Mode::Navigate;
    app.review.visible = false;
    for _ in 0..30 {
        key(&mut app, KeyCode::Char(']'));
    }
    assert!(ui::geometry(area, &app).panes[0].width >= 48);
    for _ in 0..30 {
        key(&mut app, KeyCode::Char('['));
    }
    assert_eq!(app.sidebar_width, 22);
}
