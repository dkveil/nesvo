//! Input intents and host commands live here, outside rendering.
use crate::{
    input,
    launch::{Field, SessionForm},
    model::{App, Dialog, Mode, MoveTarget, RowKind, TextAction},
    theme::Theme,
    ui,
    ui_controls::{self, Action},
};
use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind,
};
use ratatui::layout::Rect;
use serde_json::{Value, json};

pub struct Outcome {
    pub commands: Vec<Value>,
    pub quit: bool,
    pub redraw: bool,
}

impl Default for Outcome {
    fn default() -> Self {
        Self {
            commands: Vec::new(),
            quit: false,
            redraw: true,
        }
    }
}

pub fn event(app: &mut App, event: Event, area: Rect) -> Outcome {
    let mut outcome = Outcome::default();
    match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => {
            if key.code == KeyCode::F(1) {
                app.dialog = Some(Dialog::Menu);
            } else if app.dialog.is_some() {
                dialog_key(app, key, &mut outcome);
            } else if key.code == KeyCode::Esc {
                outcome.quit = true;
            } else if app.mode == Mode::Input {
                let was_scrolled = app
                    .active_terminal()
                    .is_some_and(|terminal| terminal.screen().scrollback() > 0);
                if key.code == KeyCode::Char('g') && key.modifiers.contains(KeyModifiers::CONTROL) {
                    app.mode = Mode::Navigate;
                    app.notice = "Navigation mode · i returns to the terminal".into();
                } else if let Some(data) = app
                    .active_terminal()
                    .and_then(|terminal| input::encode_key(key, terminal.screen()))
                    && let Some(command) = app.input(data)
                {
                    outcome.commands.push(command);
                    // Input is rendered when the host echoes it. Avoid a separate
                    // console write for a key that has not changed the local view.
                    outcome.redraw = was_scrolled;
                }
            } else {
                navigation_key(app, key, area, &mut outcome);
            }
        }
        Event::Paste(text) => {
            if let Some(Dialog::NewSession(form)) = &mut app.dialog {
                form.append(&text);
            } else if let Some(Dialog::Text { value, .. }) = &mut app.dialog {
                for c in text
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(80usize.saturating_sub(value.chars().count()))
                {
                    value.push(c);
                }
            } else if app.dialog.is_none() && app.mode == Mode::Input {
                let was_scrolled = app
                    .active_terminal()
                    .is_some_and(|terminal| terminal.screen().scrollback() > 0);
                if text.len() > 32 * 1024 {
                    app.notice = "Paste exceeds 32 KiB; nothing was sent.".into();
                } else if let Some(data) = app
                    .active_terminal()
                    .map(|terminal| input::encode_paste(&text, terminal.screen()))
                    && let Some(command) = app.input(data)
                {
                    outcome.commands.push(command);
                    outcome.redraw = was_scrolled;
                }
            }
        }
        Event::Mouse(mouse) => {
            let geometry = ui::geometry(area, app.split);
            if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
                if let Some(action) = ui_controls::hit_test(app, area, mouse.column, mouse.row) {
                    mouse_action(app, action, area, &mut outcome);
                }
            } else if matches!(
                mouse.kind,
                MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
            ) {
                let up = mouse.kind == MouseEventKind::ScrollUp;
                if let Some(Dialog::Move {
                    choices, selected, ..
                }) = &mut app.dialog
                {
                    *selected = if up {
                        selected.saturating_sub(1)
                    } else {
                        (*selected + 1).min(choices.len().saturating_sub(1))
                    };
                } else if app.dialog.is_none() {
                    if ui::tree_content(geometry.tree).contains((mouse.column, mouse.row).into()) {
                        app.selected = if up {
                            app.selected.saturating_sub(1)
                        } else {
                            (app.selected + 1).min(app.tree().len().saturating_sub(1))
                        };
                    } else if let Some(index) = (0..if app.split { 2 } else { 1 }).find(|index| {
                        geometry.panes[*index].contains((mouse.column, mouse.row).into())
                    }) && let Some(id) = app.panes[index].as_ref()
                        && let Some(terminal) = app.terminals.get_mut(id)
                    {
                        terminal.scroll(if up { 3 } else { -3 });
                    }
                }
            }
        }
        _ => {}
    }
    outcome
}

fn mouse_action(app: &mut App, action: Action, area: Rect, outcome: &mut Outcome) {
    match action {
        Action::Navigation(key) | Action::PaneNavigation { key, .. } => {
            if let Action::PaneNavigation { pane, .. } = action {
                app.focused = pane;
            }
            app.mode = Mode::Navigate;
            navigation_key(
                app,
                KeyEvent::new(KeyCode::Char(key), KeyModifiers::NONE),
                area,
                outcome,
            );
        }
        Action::Submit => {
            if let Some(command) = app.submit_dialog() {
                outcome.commands.push(command);
            }
        }
        Action::Cancel => app.dialog = None,
        Action::Field(field) => {
            if let Some(Dialog::NewSession(form)) = &mut app.dialog {
                form.field = field;
            }
        }
        Action::Program(program) => {
            if let Some(Dialog::NewSession(form)) = &mut app.dialog {
                form.program = program;
                form.field = Field::Program;
            }
        }
        Action::MoveChoice(index) => {
            if let Some(Dialog::Move { selected, .. }) = &mut app.dialog {
                *selected = index;
            }
        }
        Action::OpenRow(index) => {
            app.selected = index;
            app.mode = Mode::Navigate;
            open_selected(app, outcome);
        }
        Action::FocusPane(index) => {
            app.focused = index;
            app.mode = Mode::Navigate;
            if let Some(id) = app.panes[index].clone()
                && let Some(selected) = app
                    .tree()
                    .iter()
                    .position(|row| row.kind == RowKind::Session(id.clone()))
            {
                app.selected = selected;
                outcome.commands.extend(app.activate_session(&id));
            }
        }
        Action::MenuChoice(index) => menu_choice(app, index, outcome),
        Action::ThemeChoice(index) => {
            apply_theme(app, index);
        }
    }
}

fn dialog_key(app: &mut App, key: KeyEvent, outcome: &mut Outcome) {
    if key.code == KeyCode::Esc {
        match app.dialog {
            Some(Dialog::Menu) => outcome.quit = true,
            Some(Dialog::Theme { .. }) => app.dialog = Some(Dialog::Menu),
            _ => app.dialog = None,
        }
        return;
    }
    if matches!(app.dialog, Some(Dialog::Menu)) {
        match key.code {
            KeyCode::Up | KeyCode::BackTab => app.menu_selected = (app.menu_selected + 2) % 3,
            KeyCode::Down | KeyCode::Tab => app.menu_selected = (app.menu_selected + 1) % 3,
            KeyCode::Enter => menu_choice(app, app.menu_selected, outcome),
            KeyCode::Char('1'..='3') => {
                if let KeyCode::Char(value) = key.code {
                    menu_choice(app, value as usize - '1' as usize, outcome);
                }
            }
            _ => {}
        }
        return;
    }
    if let Some(Dialog::Theme { selected }) = &mut app.dialog {
        match key.code {
            KeyCode::Up | KeyCode::BackTab => {
                *selected = (*selected + Theme::ALL.len() - 1) % Theme::ALL.len();
            }
            KeyCode::Down | KeyCode::Tab => *selected = (*selected + 1) % Theme::ALL.len(),
            KeyCode::Enter => {
                let index = *selected;
                apply_theme(app, index);
            }
            _ => {}
        }
        return;
    }
    let confirm = key.code == KeyCode::Enter
        || (key.code == KeyCode::Char('y') && matches!(app.dialog, Some(Dialog::Confirm { .. })));
    if confirm {
        if let Some(command) = app.submit_dialog() {
            outcome.commands.push(command);
        }
        return;
    }
    match &mut app.dialog {
        Some(Dialog::NewSession(form)) => match key.code {
            KeyCode::Tab => form.cycle_field(false),
            KeyCode::BackTab => form.cycle_field(true),
            KeyCode::Left | KeyCode::Up if form.field == Field::Program => form.cycle_program(true),
            KeyCode::Right | KeyCode::Down if form.field == Field::Program => {
                form.cycle_program(false)
            }
            KeyCode::Backspace => form.backspace(),
            KeyCode::Char(c)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                form.append(&c.to_string())
            }
            _ => {}
        },
        Some(Dialog::Text { value, .. }) => match key.code {
            KeyCode::Backspace => {
                value.pop();
            }
            KeyCode::Char(c)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                    && !c.is_control()
                    && value.chars().count() < 80 =>
            {
                value.push(c)
            }
            _ => {}
        },
        Some(Dialog::Move {
            choices, selected, ..
        }) => match key.code {
            KeyCode::Up | KeyCode::Char('k') => *selected = selected.saturating_sub(1),
            KeyCode::Down | KeyCode::Char('j') => {
                *selected = (*selected + 1).min(choices.len().saturating_sub(1))
            }
            _ => {}
        },
        _ => {}
    }
}

fn menu_choice(app: &mut App, index: usize, outcome: &mut Outcome) {
    match index {
        0 => {
            app.dialog = None;
            app.menu_selected = 0;
            app.onboarded = true;
            if let Some(id) = app.active_id().map(str::to_owned) {
                outcome.commands.extend(app.activate_session(&id));
            }
        }
        1 => {
            app.dialog = Some(Dialog::Theme {
                selected: Theme::ALL
                    .iter()
                    .position(|theme| *theme == app.theme)
                    .unwrap_or(0),
            })
        }
        2 => app.dialog = Some(Dialog::PairPhone),
        _ => {}
    }
}

fn apply_theme(app: &mut App, index: usize) {
    if let Some(theme) = Theme::ALL.get(index) {
        app.theme = *theme;
        app.notice = format!("Theme: {}", theme.label());
        app.dialog = Some(Dialog::Menu);
    }
}

fn navigation_key(app: &mut App, key: KeyEvent, area: Rect, outcome: &mut Outcome) {
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        if key.code == KeyCode::Char('c') {
            outcome.quit = true;
        }
        return;
    }
    match key.code {
        KeyCode::Char('q') => outcome.quit = true,
        KeyCode::Char('?') => app.dialog = Some(Dialog::Help),
        KeyCode::Char('M') => app.dialog = Some(Dialog::Menu),
        KeyCode::Char('p') => app.dialog = Some(Dialog::PairPhone),
        KeyCode::Up | KeyCode::Char('k') => app.selected = app.selected.saturating_sub(1),
        KeyCode::Down | KeyCode::Char('j') => {
            app.selected = (app.selected + 1).min(app.tree().len().saturating_sub(1))
        }
        KeyCode::Enter => open_selected(app, outcome),
        KeyCode::Left | KeyCode::Char('h') => {
            if let Some(row) = app.selected_row()
                && let RowKind::Group(id) = row.kind
            {
                app.collapsed.insert(id);
            }
        }
        KeyCode::Right | KeyCode::Char('l') => {
            if let Some(row) = app.selected_row()
                && let RowKind::Group(id) = row.kind
            {
                app.collapsed.remove(&id);
            }
        }
        KeyCode::Char('i') => acquire(app, false, area, outcome),
        KeyCode::Char('e') => {
            if let Some(command) = app.input("\x1b".into()) {
                outcome.commands.push(command);
                app.mode = Mode::Input;
            }
        }
        KeyCode::Char('t') => acquire(app, true, area, outcome),
        KeyCode::Char('x') => {
            if let Some(id) = app.active_id()
                && let Some(lease) = app.leases.get(id)
            {
                outcome
                    .commands
                    .push(json!({"type":"releaseControl","sessionId":id,"leaseId":lease}));
            }
        }
        KeyCode::Tab | KeyCode::BackTab if app.split => {
            app.focused = 1 - app.focused;
        }
        KeyCode::Char('v') => {
            app.split = !app.split;
            if app.split {
                app.focused = 1;
                if let Some(id) = app
                    .sessions
                    .iter()
                    .find(|s| app.panes[0].as_deref() != Some(&s.id))
                    .map(|s| s.id.clone())
                {
                    outcome.commands.extend(app.activate_session(&id));
                }
            } else {
                app.focused = 0;
                app.panes[1] = None;
                if let Some(id) = app.active_id().map(str::to_owned) {
                    outcome.commands.extend(app.activate_session(&id));
                }
            }
        }
        KeyCode::Char('n') => {
            app.dialog = Some(Dialog::NewSession(SessionForm {
                group_id: app.selected_group(),
                ..Default::default()
            }))
        }
        KeyCode::Char('g') | KeyCode::Char('G') => {
            let parent_id = if key.code == KeyCode::Char('G') {
                app.selected_group()
            } else {
                None
            };
            app.dialog = Some(Dialog::Text {
                title: if parent_id.is_some() {
                    "New subgroup"
                } else {
                    "New group"
                }
                .into(),
                value: String::new(),
                action: TextAction::NewGroup { parent_id },
            });
        }
        KeyCode::Char('r') => rename_selected(app),
        KeyCode::Char('m') => move_selected(app),
        KeyCode::Char('d') => close_selected(app),
        KeyCode::PageUp | KeyCode::PageDown => {
            if let Some(id) = app.active_id().map(str::to_owned)
                && let Some(terminal) = app.terminals.get_mut(&id)
            {
                terminal.scroll(if key.code == KeyCode::PageUp { 12 } else { -12 });
            }
        }
        _ => {}
    }
}

fn open_selected(app: &mut App, outcome: &mut Outcome) {
    if let Some(row) = app.selected_row() {
        match row.kind {
            RowKind::Session(id) => outcome.commands.extend(app.activate_session(&id)),
            RowKind::Group(id) => {
                if !app.collapsed.remove(&id) {
                    app.collapsed.insert(id);
                }
            }
            RowKind::Root => {}
        }
    }
}

fn acquire(app: &mut App, take_over: bool, area: Rect, outcome: &mut Outcome) {
    let Some(session) = app.active_session() else {
        return;
    };
    if !session.running {
        app.notice = "This process has exited. Create a new session.".into();
        return;
    }
    if app.owns(&session.id) {
        app.mode = Mode::Input;
        return;
    }
    let inner = ui::pane_content(ui::geometry(area, app.split).panes[app.focused]);
    let command = json!({"type":"acquireControl","sessionId":session.id,"takeOver":take_over,
        "cols":inner.width.clamp(10,300),"rows":inner.height.clamp(2,150)});
    if take_over && session.controller_id.is_some() {
        app.dialog = Some(Dialog::Confirm {
            title: "Take control from the other client?".into(),
            command,
        });
    } else {
        outcome.commands.push(command);
        app.notice = "Requesting control…".into();
    }
}

fn rename_selected(app: &mut App) {
    let Some(row) = app.selected_row() else {
        return;
    };
    let action = match row.kind {
        RowKind::Session(id) => TextAction::RenameSession { id },
        RowKind::Group(id) => TextAction::RenameGroup { id },
        RowKind::Root => return,
    };
    app.dialog = Some(Dialog::Text {
        title: "Rename".into(),
        value: row.label,
        action,
    });
}

fn move_selected(app: &mut App) {
    let Some(row) = app.selected_row() else {
        return;
    };
    let (target, choices) = match row.kind {
        RowKind::Session(id) => (MoveTarget::Session(id), app.group_choices(None)),
        RowKind::Group(id) => {
            let choices = app.group_choices(Some(&id));
            (MoveTarget::Group(id), choices)
        }
        RowKind::Root => return,
    };
    app.dialog = Some(Dialog::Move {
        target,
        choices,
        selected: 0,
    });
}

fn close_selected(app: &mut App) {
    let Some(row) = app.selected_row() else {
        return;
    };
    let (title, command) = match row.kind {
        RowKind::Session(id) => (
            format!("Delete {}? Its running process will stop.", row.label),
            json!({"type":"close","sessionId":id}),
        ),
        RowKind::Group(id) => (
            format!("Delete empty group {}?", row.label),
            json!({"type":"deleteGroup","groupId":id,"expectedRevision":app.revision}),
        ),
        RowKind::Root => return,
    };
    app.dialog = Some(Dialog::Confirm { title, command });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::MouseEvent;

    fn click(app: &mut App, area: Rect, action: Action) -> Outcome {
        let target = ui_controls::controls(app, area)
            .into_iter()
            .find(|control| control.action == action)
            .expect("visible control");
        event(
            app,
            Event::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: target.area.x,
                row: target.area.y,
                modifiers: KeyModifiers::NONE,
            }),
            area,
        )
    }

    #[test]
    fn clicking_launch_fields_and_program_does_not_submit_until_create() {
        let mut app = App::new(1);
        app.event(json!({"type":"capabilities","workspace":"/work","programs":[{"id":"shell","available":true},{"id":"claude","available":true}]})).unwrap();
        let area = Rect::new(0, 0, 100, 32);
        assert!(
            click(&mut app, area, Action::Navigation('n'))
                .commands
                .is_empty()
        );
        assert!(
            click(&mut app, area, Action::Field(Field::Directory))
                .commands
                .is_empty()
        );
        event(&mut app, Event::Paste("/work/project".into()), area);
        assert!(
            click(
                &mut app,
                area,
                Action::Program(crate::launch::Program::Claude)
            )
            .commands
            .is_empty()
        );
        click(&mut app, area, Action::Field(Field::Name));
        event(&mut app, Event::Paste("Review".into()), area);
        let outcome = click(&mut app, area, Action::Submit);
        assert_eq!(outcome.commands.len(), 1);
        assert_eq!(outcome.commands[0]["name"], "Review");
        assert_eq!(outcome.commands[0]["cwd"], "/work/project");
        assert_eq!(outcome.commands[0]["program"], "claude");
    }

    #[test]
    fn clicking_empty_pane_creates_there_without_replacing_the_other_session() {
        let mut app = App::new(1);
        let existing = json!({"id":"existing","name":"Shell","cwd":"/work","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null});
        app.event(json!({"type":"sessions","revision":0,"groups":[],"sessions":[existing]}))
            .unwrap();
        app.event(json!({"type":"capabilities","workspace":"/work","programs":[{"id":"shell","available":true}]}))
            .unwrap();
        app.split = true;
        app.focused = 0;
        assert_eq!(app.panes, [Some("existing".into()), None]);

        let area = Rect::new(0, 0, 120, 36);
        let opened = click(&mut app, area, Action::PaneNavigation { pane: 1, key: 'n' });
        assert!(opened.commands.is_empty());
        assert_eq!(app.focused, 1);
        assert!(matches!(app.dialog, Some(Dialog::NewSession(_))));
        event(&mut app, Event::Paste("Second shell".into()), area);
        let created = click(&mut app, area, Action::Submit);
        assert_eq!(created.commands.len(), 1);
        assert_eq!(created.commands[0]["type"], "create");
        app.event(json!({"type":"created","sessionId":"new","requestId":created.commands[0]["requestId"]}))
            .unwrap();
        let subscribed = app.event(json!({"type":"sessions","revision":0,"groups":[],"sessions":[
            existing,
            {"id":"new","name":"Second shell","cwd":"/work","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        assert_eq!(app.panes, [Some("existing".into()), Some("new".into())]);
        assert!(
            subscribed
                .iter()
                .any(|command| command["type"] == "subscribe" && command["sessionId"] == "new")
        );
        assert!(
            !subscribed
                .iter()
                .any(|command| command["type"] == "unsubscribe"
                    && command["sessionId"] == "existing")
        );
    }

    #[test]
    fn mouse_stop_requires_confirmation_and_popup_blocks_background() {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","revision":0,"groups":[],"sessions":[{"id":"s","name":"shell","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}]})).unwrap();
        app.selected = 1;
        let area = Rect::new(0, 0, 100, 32);
        let stop = click(&mut app, area, Action::Navigation('d'));
        assert!(stop.commands.is_empty());
        assert!(matches!(app.dialog, Some(Dialog::Confirm { .. })));
        let ignored = event(
            &mut app,
            Event::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: 1,
                row: 4,
                modifiers: KeyModifiers::NONE,
            }),
            area,
        );
        assert!(ignored.commands.is_empty());
        assert!(matches!(app.dialog, Some(Dialog::Confirm { .. })));
        assert!(click(&mut app, area, Action::Cancel).commands.is_empty());
        assert!(app.dialog.is_none());
        click(&mut app, area, Action::Navigation('d'));
        let confirmed = click(&mut app, area, Action::Submit);
        assert_eq!(confirmed.commands[0]["type"], "close");
        assert_eq!(confirmed.commands[0]["sessionId"], "s");
    }

    #[test]
    fn clicking_unavailable_program_cannot_create_and_pane_click_sends_no_input() {
        let mut app = App::new(1);
        let area = Rect::new(0, 0, 100, 32);
        click(&mut app, area, Action::Navigation('n'));
        click(
            &mut app,
            area,
            Action::Program(crate::launch::Program::Gemini),
        );
        assert!(click(&mut app, area, Action::Submit).commands.is_empty());
        assert!(matches!(app.dialog, Some(Dialog::NewSession(_))));
        click(&mut app, area, Action::Cancel);
        app.split = true;
        let pane = ui::geometry(area, true).panes[1];
        let result = event(
            &mut app,
            Event::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: pane.x,
                row: pane.y,
                modifiers: KeyModifiers::NONE,
            }),
            area,
        );
        assert_eq!(app.focused, 1);
        assert!(app.mode == Mode::Navigate);
        assert!(result.commands.is_empty());
    }

    #[test]
    fn control_g_never_reaches_the_host() {
        let mut app = App::new(1);
        app.mode = Mode::Input;
        let outcome = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL)),
            Rect::new(0, 0, 100, 30),
        );
        assert!(app.mode == Mode::Navigate);
        assert!(outcome.commands.is_empty());
    }

    #[test]
    fn key_release_cannot_create_duplicate_actions() {
        let mut app = App::new(1);
        let key = KeyEvent::new_with_kind(
            KeyCode::Char('n'),
            KeyModifiers::NONE,
            KeyEventKind::Release,
        );
        event(&mut app, Event::Key(key), Rect::new(0, 0, 100, 30));
        assert!(app.dialog.is_none());
    }

    #[test]
    fn escape_detaches_and_explicit_escape_and_interrupt_reach_the_shell() {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","revision":0,"groups":[],"sessions":[
            {"id":"s","name":"shell","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        app.event(json!({"type":"subscribed","sessionId":"s","cols":80,"rows":24}))
            .unwrap();
        app.event(json!({"type":"control","sessionId":"s","controllerId":1,"cols":80,"rows":24,"leaseId":"one"})).unwrap();
        let area = Rect::new(0, 0, 100, 30);
        let escape = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            area,
        );
        assert!(escape.commands.is_empty());
        assert!(escape.quit);
        app.mode = Mode::Navigate;
        let literal_escape = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('e'), KeyModifiers::NONE)),
            area,
        );
        assert_eq!(literal_escape.commands[0]["data"], "\u{001b}");
        assert!(!literal_escape.quit);
        assert!(app.mode == Mode::Input);
        let interrupt = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            area,
        );
        assert_eq!(interrupt.commands[0]["data"], "\u{0003}");
        assert!(!interrupt.quit);
        app.mode = Mode::Navigate;
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('n'), KeyModifiers::NONE)),
            area,
        );
        let typed = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE)),
            area,
        );
        assert!(typed.commands.is_empty());
        assert!(matches!(app.dialog, Some(Dialog::NewSession(ref form)) if form.name == "x"));
        let cancel = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            area,
        );
        assert!(cancel.commands.is_empty());
        assert!(!cancel.quit);
        assert!(app.dialog.is_none());
    }

    #[test]
    fn menu_theme_and_pairing_are_local_and_f1_works_from_input() {
        let mut app = App::new(1);
        app.mode = Mode::Input;
        let area = Rect::new(0, 0, 100, 30);
        let menu = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::F(1), KeyModifiers::NONE)),
            area,
        );
        assert!(menu.commands.is_empty());
        assert!(matches!(app.dialog, Some(Dialog::Menu)));
        assert!(
            click(&mut app, area, Action::MenuChoice(1))
                .commands
                .is_empty()
        );
        assert!(matches!(app.dialog, Some(Dialog::Theme { .. })));
        assert!(
            click(&mut app, area, Action::ThemeChoice(1))
                .commands
                .is_empty()
        );
        assert_eq!(app.theme, Theme::Graphite);
        assert!(matches!(app.dialog, Some(Dialog::Menu)));
        assert!(
            click(&mut app, area, Action::MenuChoice(2))
                .commands
                .is_empty()
        );
        assert!(matches!(app.dialog, Some(Dialog::PairPhone)));
        let close = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            area,
        );
        assert!(!close.quit);
        assert!(app.dialog.is_none());
        let detach = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            area,
        );
        assert!(detach.quit);
        assert!(detach.commands.is_empty());
    }

    #[test]
    fn escape_from_theme_returns_to_menu_and_menu_escape_detaches() {
        let mut app = App::new(1);
        app.dialog = Some(Dialog::Theme { selected: 1 });
        let area = Rect::new(0, 0, 100, 30);
        let escape = Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        let back = event(&mut app, escape.clone(), area);
        assert!(!back.quit);
        assert!(back.commands.is_empty());
        assert_eq!(app.theme, Theme::Ultraviolet);
        assert!(matches!(app.dialog, Some(Dialog::Menu)));
        let detach = event(&mut app, escape, area);
        assert!(detach.quit);
        assert!(detach.commands.is_empty());
    }

    #[test]
    fn delete_key_is_literal_in_input_and_requires_confirmation_in_navigation() {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","revision":0,"groups":[],"sessions":[
            {"id":"s","name":"shell","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        app.activate_session("s");
        app.event(json!({"type":"subscribed","sessionId":"s","cols":80,"rows":24}))
            .unwrap();
        app.event(json!({"type":"control","sessionId":"s","controllerId":1,"cols":80,"rows":24,"leaseId":"one"})).unwrap();
        let area = Rect::new(0, 0, 100, 30);
        let key = KeyEvent::new(KeyCode::Char('d'), KeyModifiers::NONE);
        let typed = event(&mut app, Event::Key(key), area);
        assert_eq!(typed.commands[0]["data"], "d");
        assert!(app.dialog.is_none());
        app.mode = Mode::Navigate;
        let delete = event(&mut app, Event::Key(key), area);
        assert!(delete.commands.is_empty());
        assert!(matches!(app.dialog, Some(Dialog::Confirm { .. })));
        let confirmed = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            area,
        );
        assert_eq!(confirmed.commands[0]["type"], "close");
        assert_eq!(confirmed.commands[0]["sessionId"], "s");
    }

    #[test]
    fn launch_fields_and_pairing_action_remain_local() {
        let mut app = App::new(1);
        let area = Rect::new(0, 0, 100, 30);
        for key in [KeyCode::Char('n'), KeyCode::Char('W'), KeyCode::Tab] {
            assert!(
                event(
                    &mut app,
                    Event::Key(KeyEvent::new(key, KeyModifiers::NONE)),
                    area
                )
                .commands
                .is_empty()
            );
        }
        event(&mut app, Event::Paste("C:\\My Projects".into()), area);
        for key in [KeyCode::Tab, KeyCode::Right] {
            event(
                &mut app,
                Event::Key(KeyEvent::new(key, KeyModifiers::NONE)),
                area,
            );
        }
        assert!(
            matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.name == "W" && form.cwd == "C:\\My Projects" && form.program == crate::launch::Program::Claude)
        );
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            area,
        );
        let outcome = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::NONE)),
            area,
        );
        assert!(outcome.commands.is_empty());
        assert!(matches!(app.dialog, Some(Dialog::PairPhone)));
    }
}
