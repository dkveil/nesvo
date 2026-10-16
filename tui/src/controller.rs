//! Input intents and host commands live here, outside rendering.
use crate::{
    input,
    model::{App, Dialog, Mode, MoveTarget, RowKind, TextAction},
    ui,
};
use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind,
};
use ratatui::layout::Rect;
use serde_json::{Value, json};

#[derive(Default)]
pub struct Outcome {
    pub commands: Vec<Value>,
    pub quit: bool,
}

pub fn event(app: &mut App, event: Event, area: Rect) -> Outcome {
    let mut outcome = Outcome::default();
    match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => {
            if app.dialog.is_some() {
                dialog_key(app, key, &mut outcome);
            } else if app.mode == Mode::Input {
                if key.code == KeyCode::Char('g') && key.modifiers.contains(KeyModifiers::CONTROL) {
                    app.mode = Mode::Navigate;
                    app.notice = "Navigation mode · i returns to the terminal".into();
                } else if let Some(data) = app
                    .active_terminal()
                    .and_then(|terminal| input::encode_key(key, terminal.screen()))
                    && let Some(command) = app.input(data)
                {
                    outcome.commands.push(command);
                }
            } else {
                navigation_key(app, key, area, &mut outcome);
            }
        }
        Event::Paste(text) => {
            if let Some(Dialog::Text { value, .. }) = &mut app.dialog {
                for c in text
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(80usize.saturating_sub(value.chars().count()))
                {
                    value.push(c);
                }
            } else if app.dialog.is_none() && app.mode == Mode::Input {
                if text.len() > 32 * 1024 {
                    app.notice = "Paste exceeds 32 KiB; nothing was sent.".into();
                } else if let Some(data) = app
                    .active_terminal()
                    .map(|terminal| input::encode_paste(&text, terminal.screen()))
                    && let Some(command) = app.input(data)
                {
                    outcome.commands.push(command);
                }
            }
        }
        Event::Mouse(mouse) if app.dialog.is_none() => {
            let geometry = ui::geometry(area, app.split);
            if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
                let tree_content = ui::tree_content(geometry.tree);
                if tree_content.contains((mouse.column, mouse.row).into()) {
                    let row = usize::from(mouse.row.saturating_sub(tree_content.y));
                    app.selected = (ui::tree_offset(app, geometry.tree.height) + row)
                        .min(app.tree().len().saturating_sub(1));
                    app.mode = Mode::Navigate;
                    open_selected(app, &mut outcome);
                } else {
                    for index in 0..if app.split { 2 } else { 1 } {
                        if geometry.panes[index].contains((mouse.column, mouse.row).into()) {
                            app.focused = index;
                            app.mode = Mode::Navigate;
                        }
                    }
                }
            } else if matches!(
                mouse.kind,
                MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
            ) && let Some(id) = app.active_id().map(str::to_owned)
                && let Some(terminal) = app.terminals.get_mut(&id)
            {
                terminal.scroll(if mouse.kind == MouseEventKind::ScrollUp {
                    3
                } else {
                    -3
                });
            }
        }
        _ => {}
    }
    outcome
}

fn dialog_key(app: &mut App, key: KeyEvent, outcome: &mut Outcome) {
    if key.code == KeyCode::Esc {
        app.dialog = None;
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

fn navigation_key(app: &mut App, key: KeyEvent, area: Rect, outcome: &mut Outcome) {
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        if key.code == KeyCode::Char('c') {
            outcome.quit = true;
        }
        return;
    }
    match key.code {
        KeyCode::Char('q') => outcome.quit = true,
        KeyCode::Char('?') | KeyCode::F(1) => app.dialog = Some(Dialog::Help),
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
                    outcome.commands.extend(app.open_session(&id));
                }
            } else {
                app.focused = 0;
                app.panes[1] = None;
                if let Some(id) = app.active_id().map(str::to_owned) {
                    outcome.commands.extend(app.open_session(&id));
                }
            }
        }
        KeyCode::Char('n') => {
            app.dialog = Some(Dialog::Text {
                title: "New session on host".into(),
                value: String::new(),
                action: TextAction::NewSession {
                    group_id: app.selected_group(),
                },
            })
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
            RowKind::Session(id) => outcome.commands.extend(app.open_session(&id)),
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
            format!("Stop {} on the host?", row.label),
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
    fn shell_receives_escape_and_interrupt_but_dialog_keeps_text_local() {
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
        assert_eq!(escape.commands[0]["data"], "\u{001b}");
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
        assert!(matches!(app.dialog, Some(Dialog::Text { ref value, .. }) if value == "x"));
        let cancel = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            area,
        );
        assert!(cancel.commands.is_empty());
        assert!(app.dialog.is_none());
    }
}
