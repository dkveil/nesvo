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
    let dialog_before = app.dialog.as_ref().map(std::mem::discriminant);
    match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => {
            if key.code == KeyCode::F(1) {
                app.dialog = Some(Dialog::Menu);
            } else if app.dialog.is_some() {
                dialog_key(app, key, &mut outcome);
            } else if app.mode == Mode::Input {
                let was_scrolled = app
                    .active_terminal()
                    .is_some_and(|terminal| terminal.screen().scrollback() > 0);
                if key.code == KeyCode::Char('\u{11}')
                    || (matches!(key.code, KeyCode::Char('q' | 'Q'))
                        && key.modifiers.contains(KeyModifiers::CONTROL))
                {
                    app.mode = Mode::Navigate;
                    app.notice.clear();
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
            } else if key.code == KeyCode::Esc {
                app.dialog = Some(Dialog::ExitConfirm {
                    from_menu: false,
                    leave_selected: false,
                });
            } else {
                navigation_key(app, key, area, &mut outcome);
            }
        }
        Event::Paste(text) => {
            if let Some(Dialog::QuickSwitch { query, selected }) = &mut app.dialog {
                query.extend(
                    text.chars()
                        .filter(|c| !c.is_control())
                        .take(120usize.saturating_sub(query.chars().count())),
                );
                *selected = 0;
            } else if let Some(Dialog::NewSession(form)) = &mut app.dialog {
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
            let geometry = ui::geometry(area, app);
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
                } else if matches!(app.dialog, Some(Dialog::QuickSwitch { .. })) {
                    let count = app
                        .quick_switch_results(match &app.dialog {
                            Some(Dialog::QuickSwitch { query, .. }) => query,
                            _ => unreachable!(),
                        })
                        .len();
                    if let Some(Dialog::QuickSwitch { selected, .. }) = &mut app.dialog {
                        *selected = if up {
                            selected.saturating_sub(1)
                        } else {
                            (*selected + 1).min(count.saturating_sub(1))
                        };
                    }
                } else if app.dialog.is_none() {
                    if ui::tree_content(geometry.tree).contains((mouse.column, mouse.row).into()) {
                        app.selected = if up {
                            app.selected
                                .saturating_sub(1)
                                .max(usize::from(app.tree().len() > 1))
                        } else {
                            (app.selected + 1).min(app.tree().len().saturating_sub(1))
                        };
                        preview_selected_session(app, &mut outcome);
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
    if dialog_before != app.dialog.as_ref().map(std::mem::discriminant) {
        app.dialog_button = if matches!(app.dialog, Some(Dialog::Confirm { .. })) {
            Some(1)
        } else {
            None
        };
    }
    outcome
}

fn mouse_action(app: &mut App, action: Action, area: Rect, outcome: &mut Outcome) {
    match action {
        Action::ToggleFullscreen => app.fullscreen = !app.fullscreen,
        Action::SettingChoice(index) => {
            app.dialog_button = None;
            if let Some(Dialog::Settings { selected }) = &mut app.dialog {
                *selected = index;
            }
            change_setting(app, index, false);
        }
        Action::GroupName => {
            app.dialog_button = None;
            if let Some(Dialog::NewGroup { editing_parent, .. }) = &mut app.dialog {
                *editing_parent = false;
            }
        }
        Action::GroupParent(index) => {
            app.dialog_button = None;
            if let Some(Dialog::NewGroup {
                parent_index,
                editing_parent,
                ..
            }) = &mut app.dialog
            {
                *parent_index = index;
                *editing_parent = true;
            }
        }
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
            if matches!(app.dialog, Some(Dialog::ExitConfirm { .. })) {
                outcome.quit = true;
            } else {
                submit_focused_dialog(app, outcome);
            }
        }
        Action::Cancel => cancel_dialog(app),
        Action::Field(field) => {
            if let Some(Dialog::NewSession(form)) = &mut app.dialog {
                form.field = field;
            }
            app.dialog_button = None;
            if field == Field::Directory {
                open_folder_picker(app, outcome);
            }
        }
        Action::Program(program) => {
            if let Some(Dialog::NewSession(form)) = &mut app.dialog {
                form.program = program;
                form.field = Field::Program;
            }
            app.dialog_button = None;
        }
        Action::DirectoryChoice(index) => open_directory_choice(app, index, outcome),
        Action::MoveChoice(index) => {
            app.dialog_button = None;
            if let Some(Dialog::Move { selected, .. }) = &mut app.dialog {
                *selected = index;
            }
        }
        Action::QuickChoice(index) => {
            if let Some(Dialog::QuickSwitch { selected, .. }) = &mut app.dialog {
                *selected = index;
            }
            open_quick_choice(app, outcome);
        }
        Action::OpenRow(index) => {
            app.selected = index;
            if let Some(row) = app.selected_row() {
                match row.kind {
                    RowKind::Session(id) => outcome.commands.extend(app.open_session(&id)),
                    RowKind::Group(id) => toggle_group(app, id),
                    RowKind::Root => {}
                }
            }
            app.mode = Mode::Navigate;
        }
        Action::FocusPane(index) => {
            app.focused = index;
            if let Some(id) = app.panes[index].clone()
                && let Some(selected) = app
                    .tree()
                    .iter()
                    .position(|row| row.kind == RowKind::Session(id.clone()))
            {
                app.selected = selected;
                outcome.commands.extend(app.open_session(&id));
            }
            app.mode = Mode::Navigate;
        }
        Action::FocusTab(index) => {
            if let Some(id) = app.tabs.get(index).cloned() {
                if let Some(selected) = app
                    .tree()
                    .iter()
                    .position(|row| row.kind == RowKind::Session(id.clone()))
                {
                    app.selected = selected;
                }
                outcome.commands.extend(app.open_session(&id));
            }
        }
        Action::MenuChoice(index) => menu_choice(app, index, outcome),
    }
}

fn dialog_key(app: &mut App, key: KeyEvent, outcome: &mut Outcome) {
    if key.code == KeyCode::Esc {
        if matches!(app.dialog, Some(Dialog::Menu)) {
            app.dialog = Some(Dialog::ExitConfirm {
                from_menu: true,
                leave_selected: false,
            });
        } else {
            cancel_dialog(app);
        }
        return;
    }
    if let Some(Dialog::ExitConfirm { leave_selected, .. }) = &mut app.dialog {
        match key.code {
            KeyCode::Left => *leave_selected = true,
            KeyCode::Right => *leave_selected = false,
            KeyCode::Tab | KeyCode::BackTab | KeyCode::Up | KeyCode::Down => {
                *leave_selected = !*leave_selected;
            }
            KeyCode::Enter if *leave_selected => outcome.quit = true,
            KeyCode::Enter => cancel_dialog(app),
            KeyCode::Char('y' | 'Y') => outcome.quit = true,
            KeyCode::Char('n' | 'N') => cancel_dialog(app),
            _ => {}
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
    if matches!(app.dialog, Some(Dialog::QuickSwitch { .. })) && app.dialog_button == Some(0) {
        match key.code {
            KeyCode::Enter => cancel_dialog(app),
            KeyCode::Up | KeyCode::BackTab => app.dialog_button = None,
            _ => {}
        }
        return;
    }
    if let Some(Dialog::QuickSwitch { query, selected }) = &app.dialog {
        let count = app.quick_switch_results(query).len();
        let mut next_query = query.clone();
        let mut next_selected = *selected;
        match key.code {
            KeyCode::Enter => {
                open_quick_choice(app, outcome);
                return;
            }
            KeyCode::Up | KeyCode::Char('p')
                if key.code == KeyCode::Up || key.modifiers.contains(KeyModifiers::CONTROL) =>
            {
                next_selected = next_selected.saturating_sub(1)
            }
            KeyCode::Tab => app.dialog_button = Some(0),
            KeyCode::Down if next_selected + 1 >= count => app.dialog_button = Some(0),
            KeyCode::Down | KeyCode::Char('n')
                if key.code == KeyCode::Down || key.modifiers.contains(KeyModifiers::CONTROL) =>
            {
                next_selected = (next_selected + 1).min(count.saturating_sub(1))
            }
            KeyCode::Backspace => {
                next_query.pop();
                next_selected = 0;
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                next_query.clear();
                next_selected = 0;
            }
            KeyCode::Char(c)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                    && !c.is_control()
                    && next_query.chars().count() < 120 =>
            {
                next_query.push(c);
                next_selected = 0;
            }
            _ => {}
        }
        app.dialog = Some(Dialog::QuickSwitch {
            query: next_query,
            selected: next_selected,
        });
        return;
    }
    if matches!(app.dialog, Some(Dialog::Confirm { .. })) && app.dialog_button.is_none() {
        app.dialog_button = Some(1);
    }
    if let Some(button) = app.dialog_button {
        let last = usize::from(matches!(
            app.dialog,
            Some(
                Dialog::NewGroup { .. }
                    | Dialog::NewSession(_)
                    | Dialog::FolderPicker { .. }
                    | Dialog::Text { .. }
                    | Dialog::Move { .. }
                    | Dialog::Confirm { .. }
            )
        ));
        match key.code {
            KeyCode::Left => app.dialog_button = Some(button.saturating_sub(1)),
            KeyCode::Right | KeyCode::Down | KeyCode::Tab => {
                app.dialog_button = Some((button + 1).min(last))
            }
            KeyCode::Up | KeyCode::BackTab if button == 0 => {
                app.dialog_button = None;
                if let Some(Dialog::NewSession(form)) = &mut app.dialog {
                    form.field = Field::Program;
                }
                if let Some(Dialog::NewGroup { editing_parent, .. }) = &mut app.dialog {
                    *editing_parent = true;
                }
            }
            KeyCode::Up | KeyCode::BackTab => app.dialog_button = Some(button - 1),
            KeyCode::Enter if button == 0 => submit_focused_dialog(app, outcome),
            KeyCode::Enter => cancel_dialog(app),
            KeyCode::Char('y' | 'Y') if matches!(app.dialog, Some(Dialog::Confirm { .. })) => {
                submit_focused_dialog(app, outcome)
            }
            KeyCode::Char('n' | 'N') if matches!(app.dialog, Some(Dialog::Confirm { .. })) => {
                cancel_dialog(app)
            }
            _ => {}
        }
        return;
    }
    if let Some(Dialog::Settings { selected }) = &mut app.dialog {
        match key.code {
            KeyCode::Up | KeyCode::BackTab => *selected = selected.saturating_sub(1),
            KeyCode::Down | KeyCode::Tab if *selected == 1 => app.dialog_button = Some(0),
            KeyCode::Down | KeyCode::Tab => *selected = 1,
            KeyCode::Left | KeyCode::Right | KeyCode::Enter | KeyCode::Char(' ') => {
                let index = *selected;
                change_setting(app, index, key.code == KeyCode::Left);
            }
            _ => {}
        }
        return;
    }
    let mut submit = false;
    let mut browse = false;
    let mut directory_choice = None;
    let mut close = false;
    match &mut app.dialog {
        Some(Dialog::NewSession(form)) => match key.code {
            KeyCode::Tab | KeyCode::Down if form.field == Field::Name => {
                form.field = Field::Directory
            }
            KeyCode::Tab | KeyCode::Down if form.field == Field::Directory => {
                form.field = Field::Program
            }
            KeyCode::Tab if form.field == Field::Program => app.dialog_button = Some(0),
            KeyCode::BackTab | KeyCode::Up if form.field == Field::Directory => {
                form.field = Field::Name
            }
            KeyCode::BackTab if form.field == Field::Program => form.field = Field::Directory,
            KeyCode::Down
                if form.field == Field::Program
                    && form.program == crate::launch::Program::Codex =>
            {
                app.dialog_button = Some(0)
            }
            KeyCode::Up
                if form.field == Field::Program
                    && form.program == crate::launch::Program::Shell =>
            {
                form.field = Field::Directory
            }
            KeyCode::Up if form.field == Field::Program => form.cycle_program(true),
            KeyCode::Down if form.field == Field::Program => form.cycle_program(false),
            KeyCode::Left if form.field == Field::Program => form.cycle_program(true),
            KeyCode::Right if form.field == Field::Program => form.cycle_program(false),
            KeyCode::Enter if form.field == Field::Name => form.field = Field::Directory,
            KeyCode::Enter if form.field == Field::Directory => browse = true,
            KeyCode::Enter => submit = true,
            KeyCode::Backspace => form.backspace(),
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                if form.field == Field::Name {
                    form.name.clear();
                }
            }
            KeyCode::Char(c)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                form.append(&c.to_string())
            }
            _ => {}
        },
        Some(Dialog::NewGroup {
            name,
            parent_index,
            editing_parent,
        }) => match key.code {
            KeyCode::Tab | KeyCode::Down if !*editing_parent => *editing_parent = true,
            KeyCode::Tab if *editing_parent => app.dialog_button = Some(0),
            KeyCode::BackTab if *editing_parent => *editing_parent = false,
            KeyCode::Enter if !*editing_parent => *editing_parent = true,
            KeyCode::Enter => submit = true,
            KeyCode::Up if *editing_parent && *parent_index == 0 => *editing_parent = false,
            KeyCode::Up | KeyCode::Left if *editing_parent => {
                *parent_index = parent_index.saturating_sub(1)
            }
            KeyCode::Down if *editing_parent && *parent_index == app.groups.len() => {
                app.dialog_button = Some(0)
            }
            KeyCode::Down | KeyCode::Right if *editing_parent => {
                *parent_index = (*parent_index + 1).min(app.groups.len());
            }
            KeyCode::Backspace if !*editing_parent => {
                name.pop();
            }
            KeyCode::Char(c)
                if !*editing_parent
                    && !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                    && !c.is_control()
                    && name.chars().count() < 80 =>
            {
                name.push(c)
            }
            _ => {}
        },
        Some(Dialog::Text { value, .. }) => match key.code {
            KeyCode::Tab | KeyCode::Down => app.dialog_button = Some(0),
            KeyCode::Enter => submit = true,
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
            KeyCode::Tab => app.dialog_button = Some(0),
            KeyCode::Enter => submit = true,
            KeyCode::Up | KeyCode::Char('k') => *selected = selected.saturating_sub(1),
            KeyCode::Down if *selected + 1 >= choices.len() => app.dialog_button = Some(0),
            KeyCode::Down | KeyCode::Char('j') => {
                *selected = (*selected + 1).min(choices.len().saturating_sub(1))
            }
            _ => {}
        },
        Some(Dialog::FolderPicker {
            parent,
            entries,
            selected,
            ..
        }) => match key.code {
            KeyCode::Tab => app.dialog_button = Some(0),
            KeyCode::Up => *selected = selected.saturating_sub(1),
            KeyCode::Down if *selected + 1 >= entries.len() + usize::from(parent.is_some()) => {
                app.dialog_button = Some(0)
            }
            KeyCode::Down => *selected += 1,
            KeyCode::Enter | KeyCode::Right => directory_choice = Some(*selected),
            KeyCode::Backspace | KeyCode::Left if parent.is_some() => directory_choice = Some(0),
            _ => {}
        },
        Some(Dialog::Confirm { .. }) => match key.code {
            KeyCode::Tab | KeyCode::Down => app.dialog_button = Some(0),
            KeyCode::Enter | KeyCode::Char('y' | 'Y') => submit = true,
            _ => {}
        },
        Some(Dialog::Help | Dialog::PairPhone) => match key.code {
            KeyCode::Tab | KeyCode::Down => app.dialog_button = Some(0),
            KeyCode::Enter => close = true,
            _ => {}
        },
        _ => {}
    }
    if submit {
        submit_focused_dialog(app, outcome);
    }
    if browse {
        open_folder_picker(app, outcome);
    }
    if let Some(index) = directory_choice {
        open_directory_choice(app, index, outcome);
    }
    if close {
        cancel_dialog(app);
    }
}

fn cancel_dialog(app: &mut App) {
    app.dialog = match app.dialog.take() {
        Some(Dialog::FolderPicker { form, .. }) => {
            app.pending_directory_cancel();
            Some(Dialog::NewSession(form))
        }
        Some(
            Dialog::Settings { .. }
            | Dialog::ExitConfirm {
                from_menu: true, ..
            },
        ) => Some(Dialog::Menu),
        _ => None,
    };
    app.dialog_button = None;
}

fn submit_focused_dialog(app: &mut App, outcome: &mut Outcome) {
    if matches!(app.dialog, Some(Dialog::FolderPicker { .. })) {
        let Some(Dialog::FolderPicker { form, path, .. }) = app.dialog.take() else {
            unreachable!()
        };
        let mut form = form;
        form.cwd = path;
        form.field = Field::Directory;
        app.pending_directory_cancel();
        app.dialog = Some(Dialog::NewSession(form));
        app.dialog_button = None;
    } else if matches!(
        app.dialog,
        Some(Dialog::Settings { .. } | Dialog::Help | Dialog::PairPhone)
    ) {
        cancel_dialog(app);
    } else if let Some(command) = app.submit_dialog() {
        outcome.commands.push(command);
    }
}

fn open_folder_picker(app: &mut App, outcome: &mut Outcome) {
    let Some(caps) = app.capabilities.as_ref() else {
        app.notice = "Waiting for the host's workspace.".into();
        return;
    };
    if !caps.directory_browser {
        app.notice =
            "Folder browser needs an updated nesvo-host. Reconnect to the new host.".into();
        return;
    }
    let workspace = caps.workspace.clone();
    let Some(Dialog::NewSession(form)) = app.dialog.take() else {
        return;
    };
    let path = if form.cwd.is_empty() {
        workspace
    } else {
        form.cwd.clone()
    };
    app.dialog = Some(Dialog::FolderPicker {
        form,
        path: path.clone(),
        parent: None,
        entries: Vec::new(),
        selected: 0,
        loading: true,
    });
    app.dialog_button = None;
    outcome.commands.push(app.browse_directory(path));
}

fn open_directory_choice(app: &mut App, index: usize, outcome: &mut Outcome) {
    let Some(Dialog::FolderPicker {
        parent,
        entries,
        loading,
        ..
    }) = &app.dialog
    else {
        return;
    };
    if *loading {
        return;
    }
    let target = if parent.is_some() && index == 0 {
        parent.clone()
    } else {
        entries
            .get(index.saturating_sub(usize::from(parent.is_some())))
            .map(|entry| entry.path.clone())
    };
    if let Some(path) = target {
        app.dialog_button = None;
        outcome.commands.push(app.browse_directory(path));
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
        1 => app.dialog = Some(Dialog::PairPhone),
        2 => app.dialog = Some(Dialog::Settings { selected: 0 }),
        _ => {}
    }
}

fn open_quick_choice(app: &mut App, outcome: &mut Outcome) {
    let Some(Dialog::QuickSwitch { query, selected }) = &app.dialog else {
        return;
    };
    let id = app
        .quick_switch_results(query)
        .get(*selected)
        .map(|session| session.id.clone());
    if let Some(id) = id {
        app.dialog = None;
        if let Some(index) = app
            .tree()
            .iter()
            .position(|row| row.kind == RowKind::Session(id.clone()))
        {
            app.selected = index;
        }
        outcome.commands.extend(app.activate_session(&id));
    }
}

fn apply_theme(app: &mut App, index: usize) {
    if let Some(theme) = Theme::ALL.get(index) {
        app.theme = *theme;
    }
}

fn change_setting(app: &mut App, index: usize, reverse: bool) {
    match index {
        0 => {
            let current = Theme::ALL
                .iter()
                .position(|theme| *theme == app.theme)
                .unwrap_or(0);
            let next =
                (current + if reverse { Theme::ALL.len() - 1 } else { 1 }) % Theme::ALL.len();
            apply_theme(app, next);
        }
        1 => {
            app.fullscreen_default = !app.fullscreen_default;
            app.fullscreen = app.fullscreen_default;
        }
        _ => {}
    }
}

fn navigation_key(app: &mut App, key: KeyEvent, area: Rect, outcome: &mut Outcome) {
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        if key.code == KeyCode::Char('c') {
            outcome.quit = true;
        } else if matches!(key.code, KeyCode::Char('k' | 'K' | '\u{0b}')) {
            app.dialog = Some(Dialog::QuickSwitch {
                query: String::new(),
                selected: 0,
            });
        }
        return;
    }
    match key.code {
        KeyCode::Char('/' | '\u{0b}') => {
            app.dialog = Some(Dialog::QuickSwitch {
                query: String::new(),
                selected: 0,
            })
        }
        KeyCode::Char('q') => outcome.quit = true,
        KeyCode::Char('z') => app.fullscreen = !app.fullscreen,
        KeyCode::Char('?') => app.dialog = Some(Dialog::Help),
        KeyCode::Char('M') => app.dialog = Some(Dialog::Menu),
        KeyCode::Char('p') => app.dialog = Some(Dialog::PairPhone),
        KeyCode::Up | KeyCode::Char('k') => {
            app.selected = app
                .selected
                .saturating_sub(1)
                .max(usize::from(app.tree().len() > 1));
            preview_selected_session(app, outcome);
        }
        KeyCode::Down | KeyCode::Char('j') => {
            app.selected = (app.selected + 1).min(app.tree().len().saturating_sub(1));
            preview_selected_session(app, outcome);
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
                program: app
                    .active_session()
                    .map_or(crate::launch::Program::Shell, |session| {
                        app.effective_program(session)
                    }),
                ..Default::default()
            }))
        }
        KeyCode::Char('g') | KeyCode::Char('G') => {
            let parent = app.selected_group();
            let parent_index = app
                .group_choices(None)
                .iter()
                .position(|(id, _)| id == &parent)
                .unwrap_or(0);
            app.dialog = Some(Dialog::NewGroup {
                name: String::new(),
                parent_index,
                editing_parent: false,
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
            RowKind::Group(id) => toggle_group(app, id),
            RowKind::Root => {}
        }
    }
}

fn preview_selected_session(app: &mut App, outcome: &mut Outcome) {
    if let Some(RowKind::Session(id)) = app.selected_row().map(|row| row.kind) {
        outcome.commands.extend(app.open_session(&id));
    }
}

fn toggle_group(app: &mut App, id: String) {
    if !app.collapsed.insert(id.clone()) {
        app.collapsed.remove(&id);
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
    let inner = if app.fullscreen {
        Rect::new(area.x, area.y, area.width, area.height.saturating_sub(1))
    } else {
        ui::pane_content(ui::geometry(area, app).panes[app.focused], false)
    };
    let command = json!({"type":"acquireControl","sessionId":session.id,"takeOver":take_over,
        "cols":inner.width.clamp(10,300),"rows":inner.height.clamp(2,150)});
    if take_over && session.controller_id.is_some() {
        app.dialog = Some(Dialog::Confirm {
            title: "Take control?".into(),
            detail: "The other client will lose keyboard control of this session.".into(),
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
    let (title, detail, command) = match row.kind {
        RowKind::Session(id) => (
            "Delete session?".to_owned(),
            format!(
                "{} will be removed. Its running process will stop.",
                row.label
            ),
            json!({"type":"close","sessionId":id}),
        ),
        RowKind::Group(id) => (
            "Delete group?".to_owned(),
            format!("The empty group {} will be removed.", row.label),
            json!({"type":"deleteGroup","groupId":id,"expectedRevision":app.revision}),
        ),
        RowKind::Root => return,
    };
    app.dialog = Some(Dialog::Confirm {
        title,
        detail,
        command,
    });
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
    fn quick_switch_filters_and_opens_matching_session() {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"one","name":"Docs","cwd":"C:/dev/docs","program":"claude","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null},
            {"id":"two","name":"Web UI","cwd":"C:/dev/web","program":"codex","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        let area = Rect::new(0, 0, 100, 30);
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE)),
            area,
        );
        assert!(matches!(app.dialog, Some(Dialog::QuickSwitch { .. })));
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)),
            area,
        );
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)),
            area,
        );
        assert_eq!(app.dialog_button, Some(0));
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE)),
            area,
        );
        assert_eq!(app.dialog_button, None);
        for character in "codex".chars() {
            event(
                &mut app,
                Event::Key(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE)),
                area,
            );
        }
        assert_eq!(app.quick_switch_results("codex")[0].id, "two");
        let outcome = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            area,
        );
        assert!(app.dialog.is_none());
        assert_eq!(app.active_id(), Some("two"));
        assert!(
            outcome
                .commands
                .iter()
                .any(|command| command["type"] == "subscribe")
        );
    }

    #[test]
    fn clicking_launch_fields_and_program_does_not_submit_until_create() {
        let mut app = App::new(1);
        app.event(json!({"type":"capabilities","workspace":"/work","directoryBrowser":true,"programs":[{"id":"shell","available":true},{"id":"claude","available":true}]})).unwrap();
        let area = Rect::new(0, 0, 100, 32);
        assert!(
            click(&mut app, area, Action::Navigation('n'))
                .commands
                .is_empty()
        );
        let browse = click(&mut app, area, Action::Field(Field::Directory));
        assert_eq!(browse.commands[0]["type"], "listDirectories");
        assert_eq!(browse.commands[0]["path"], "/work");
        app.event(json!({"type":"directories","requestId":"stale","path":"/wrong","entries":[]}))
            .unwrap();
        assert!(
            matches!(&app.dialog, Some(Dialog::FolderPicker { path, loading: true, .. }) if path == "/work")
        );
        app.event(json!({"type":"directories","requestId":browse.commands[0]["requestId"],"path":"/work","parent":"/","entries":[{"name":"project","path":"/work/project"}]})).unwrap();
        let child = click(&mut app, area, Action::DirectoryChoice(1));
        assert_eq!(child.commands[0]["path"], "/work/project");
        app.event(json!({"type":"directories","requestId":child.commands[0]["requestId"],"path":"/work/project","parent":"/work","entries":[]})).unwrap();
        click(&mut app, area, Action::Submit);
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
    fn old_host_without_directory_browser_keeps_the_launch_form_open() {
        let mut app = App::new(1);
        app.event(json!({"type":"capabilities","workspace":"/work","programs":[{"id":"shell","available":true}]})).unwrap();
        let area = Rect::new(0, 0, 100, 32);
        click(&mut app, area, Action::Navigation('n'));
        let result = click(&mut app, area, Action::Field(Field::Directory));
        assert!(result.commands.is_empty());
        assert!(matches!(app.dialog, Some(Dialog::NewSession(_))));
        assert!(app.notice.contains("updated nesvo-host"));
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
        let stop = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::NONE)),
            area,
        );
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
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::NONE)),
            area,
        );
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
        let pane = ui::geometry(area, &app).panes[1];
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
    fn control_q_never_reaches_the_host() {
        let mut app = App::new(1);
        app.mode = Mode::Input;
        let outcome = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('q'), KeyModifiers::CONTROL)),
            Rect::new(0, 0, 100, 30),
        );
        assert!(app.mode == Mode::Navigate);
        assert!(outcome.commands.is_empty());
        app.mode = Mode::Input;
        let control_character = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('\u{11}'), KeyModifiers::NONE)),
            Rect::new(0, 0, 100, 30),
        );
        assert!(app.mode == Mode::Navigate);
        assert!(control_character.commands.is_empty());
    }

    #[test]
    fn control_q_reveals_the_session_list_in_fullscreen() {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","revision":0,
            "groups":[{"id":"project","parentId":null,"name":"Project","order":0}],
            "sessions":[{"id":"agent","name":"Agent","cwd":".","cols":80,"rows":24,
                "running":true,"groupId":"project","controllerId":null}]}))
            .unwrap();
        let area = Rect::new(0, 0, 100, 30);
        app.fullscreen = true;
        app.mode = Mode::Input;
        assert_eq!(ui::geometry(area, &app).tree.width, 0);
        let outcome = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('q'), KeyModifiers::CONTROL)),
            area,
        );
        assert!(outcome.commands.is_empty());
        assert!(app.fullscreen);
        assert!(app.mode == Mode::Navigate);
        let tree = ui::geometry(area, &app).tree;
        assert!(tree.width > 0);
        let content = ui::tree_content(tree);
        assert!((content.y..content.bottom()).any(|y| {
            ui::sidebar_hit(&app, tree, content.x, y)
                == app
                    .tree()
                    .iter()
                    .position(|row| row.kind == RowKind::Session("agent".into()))
        }));
    }

    #[test]
    fn navigation_arrows_preview_the_selected_session_without_control() {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","revision":0,"groups":[],"sessions":[
            {"id":"first","name":"First","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null},
            {"id":"second","name":"Second","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        let area = Rect::new(0, 0, 100, 30);
        assert_eq!(app.selected, 1);
        assert_eq!(app.active_id(), Some("first"));
        let down = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)),
            area,
        );
        assert_eq!(app.selected, 2);
        assert_eq!(app.active_id(), Some("second"));
        assert!(app.mode == Mode::Navigate);
        assert!(
            !down
                .commands
                .iter()
                .any(|command| command["type"] == "acquireControl")
        );
        let up = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE)),
            area,
        );
        assert_eq!(app.active_id(), Some("first"));
        assert!(
            !up.commands
                .iter()
                .any(|command| command["type"] == "acquireControl")
        );
    }

    #[test]
    fn session_tabs_switch_without_replacing_other_tabs() {
        let mut app = App::new(1);
        app.connected = true;
        app.event(json!({"type":"sessions","revision":0,"groups":[],"sessions":[
            {"id":"first","name":"First","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null},
            {"id":"second","name":"Second","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        app.open_session("second");
        let area = Rect::new(0, 0, 100, 30);
        let tabs = ui::tab_areas(&app, &ui::geometry(area, &app)).0;
        let first = tabs[0].1;
        let switch = event(
            &mut app,
            Event::Mouse(MouseEvent {
                kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
                column: first.x,
                row: first.y,
                modifiers: KeyModifiers::NONE,
            }),
            area,
        );
        assert_eq!(app.active_id(), Some("first"));
        assert_eq!(app.tabs, ["first", "second"]);
        assert!(
            !switch
                .commands
                .iter()
                .any(|c| c["type"] == "acquireControl")
        );
        let plus = ui::tab_areas(&app, &ui::geometry(area, &app)).1;
        event(
            &mut app,
            Event::Mouse(MouseEvent {
                kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
                column: plus.x,
                row: plus.y,
                modifiers: KeyModifiers::NONE,
            }),
            area,
        );
        assert!(matches!(app.dialog, Some(Dialog::NewSession(_))));
        assert_eq!(app.tabs, ["first", "second"]);
    }

    #[test]
    fn z_toggles_fullscreen_from_navigation_and_sidebar_click_keeps_navigation() {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","revision":0,"groups":[],"sessions":[
            {"id":"first","name":"First","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null},
            {"id":"second","name":"Second","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        let area = Rect::new(0, 0, 100, 30);
        app.mode = Mode::Navigate;
        let z = Event::Key(KeyEvent::new(KeyCode::Char('z'), KeyModifiers::NONE));
        let fullscreen = event(&mut app, z.clone(), area);
        assert!(app.fullscreen);
        assert!(app.mode == Mode::Navigate);
        assert!(ui::geometry(area, &app).tree.width > 0);
        assert!(fullscreen.commands.is_empty());
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::F(11), KeyModifiers::NONE)),
            area,
        );
        assert!(app.fullscreen);
        event(&mut app, z, area);
        assert!(!app.fullscreen);
        let tree = ui::tree_content(ui::geometry(area, &app).tree);
        let second = app
            .tree()
            .iter()
            .position(|row| row.kind == RowKind::Session("second".into()))
            .unwrap();
        let clicked_y = (tree.y..tree.bottom())
            .find(|y| {
                ui::sidebar_hit(&app, ui::geometry(area, &app).tree, tree.x, *y) == Some(second)
            })
            .unwrap();
        let row_click = event(
            &mut app,
            Event::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: tree.x,
                row: clicked_y,
                modifiers: KeyModifiers::NONE,
            }),
            area,
        );
        assert!(app.mode == Mode::Navigate);
        assert_eq!(app.active_id(), Some("second"));
        assert!(
            !row_click
                .commands
                .iter()
                .any(|command| command["type"] == "input" || command["type"] == "acquireControl")
        );
        assert!(
            click(&mut app, area, Action::ToggleFullscreen)
                .commands
                .is_empty()
        );
        assert!(app.fullscreen);
    }

    #[test]
    fn settings_change_fullscreen_default_live() {
        let mut app = App::new(1);
        let area = Rect::new(0, 0, 100, 30);
        app.dialog = Some(Dialog::Menu);
        click(&mut app, area, Action::MenuChoice(2));
        assert!(matches!(app.dialog, Some(Dialog::Settings { .. })));
        click(&mut app, area, Action::SettingChoice(1));
        assert!(app.fullscreen_default && app.fullscreen);
        assert!(matches!(app.dialog, Some(Dialog::Settings { .. })));
    }

    #[test]
    fn every_dialog_footer_is_reachable_and_its_buttons_are_keyboard_activated() {
        let dialogs = vec![
            Dialog::Settings { selected: 0 },
            Dialog::NewGroup {
                name: "Group".into(),
                parent_index: 0,
                editing_parent: false,
            },
            Dialog::NewSession(SessionForm::default()),
            Dialog::FolderPicker {
                form: SessionForm::default(),
                path: "/work".into(),
                parent: None,
                entries: vec![],
                selected: 0,
                loading: false,
            },
            Dialog::Text {
                title: "Rename".into(),
                value: "Name".into(),
                action: TextAction::RenameSession { id: "s".into() },
            },
            Dialog::Move {
                target: MoveTarget::Session("s".into()),
                choices: vec![(None, "Root".into())],
                selected: 0,
            },
            Dialog::Confirm {
                title: "Delete".into(),
                detail: "Sure?".into(),
                command: json!({"type":"close","sessionId":"s"}),
            },
            Dialog::Help,
            Dialog::PairPhone,
        ];
        let area = Rect::new(0, 0, 100, 32);
        for dialog in dialogs {
            let mut app = App::new(1);
            app.dialog = Some(dialog);
            for _ in 0..4 {
                event(
                    &mut app,
                    Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)),
                    area,
                );
            }
            assert!(app.dialog_button.is_some(), "footer was unreachable");
            event(
                &mut app,
                Event::Key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE)),
                area,
            );
            let result = event(
                &mut app,
                Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
                area,
            );
            assert!(result.commands.is_empty());
            assert!(matches!(
                app.dialog,
                Some(Dialog::Menu | Dialog::NewSession(_)) | None
            ));
        }
    }

    #[test]
    fn down_reaches_footer_and_up_returns_to_fields() {
        let mut app = App::new(1);
        let area = Rect::new(0, 0, 100, 32);
        app.dialog = Some(Dialog::Settings { selected: 0 });
        for _ in 0..2 {
            event(
                &mut app,
                Event::Key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)),
                area,
            );
        }
        assert_eq!(app.dialog_button, Some(0));
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE)),
            area,
        );
        assert_eq!(app.dialog_button, None);
        assert!(matches!(app.dialog, Some(Dialog::Settings { selected: 1 })));

        app.dialog = Some(Dialog::NewSession(SessionForm {
            program: crate::launch::Program::Codex,
            field: Field::Program,
            ..Default::default()
        }));
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)),
            area,
        );
        assert_eq!(app.dialog_button, Some(0));
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE)),
            area,
        );
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE)),
            area,
        );
        assert!(
            matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.program == crate::launch::Program::Gemini)
        );
    }

    #[test]
    fn new_session_and_group_forms_are_keyboard_navigable() {
        let mut app = App::new(1);
        let area = Rect::new(0, 0, 100, 30);
        let key = |app: &mut App, code| {
            event(
                app,
                Event::Key(KeyEvent::new(code, KeyModifiers::NONE)),
                area,
            )
        };
        key(&mut app, KeyCode::Char('n'));
        key(&mut app, KeyCode::Char('S'));
        key(&mut app, KeyCode::Enter);
        assert!(
            matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.field == Field::Directory)
        );
        key(&mut app, KeyCode::Char('p'));
        assert!(matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.cwd.is_empty()));
        key(&mut app, KeyCode::Down);
        assert!(
            matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.field == Field::Program)
        );
        key(&mut app, KeyCode::Down);
        assert!(
            matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.program == crate::launch::Program::Claude)
        );
        key(&mut app, KeyCode::Up);
        key(&mut app, KeyCode::Up);
        assert!(
            matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.field == Field::Directory)
        );
        key(&mut app, KeyCode::Up);
        assert!(matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.field == Field::Name));
        key(&mut app, KeyCode::Esc);
        app.event(json!({"type":"sessions","revision":1,"groups":[{"id":"g","parentId":null,"name":"Work","order":0}],"sessions":[]})).unwrap();
        key(&mut app, KeyCode::Char('g'));
        key(&mut app, KeyCode::Char('N'));
        key(&mut app, KeyCode::Enter);
        assert!(matches!(
            &app.dialog,
            Some(Dialog::NewGroup {
                editing_parent: true,
                ..
            })
        ));
        key(&mut app, KeyCode::Down);
        assert!(matches!(
            &app.dialog,
            Some(Dialog::NewGroup {
                parent_index: 1,
                ..
            })
        ));
        let created = key(&mut app, KeyCode::Enter);
        assert_eq!(created.commands[0]["type"], "createGroup");
        assert_eq!(created.commands[0]["name"], "N");
        assert_eq!(created.commands[0]["parentId"], "g");
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
    fn escape_reaches_the_shell_then_control_q_returns_to_navigation() {
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
        assert!(!escape.quit);
        let navigation = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('q'), KeyModifiers::CONTROL)),
            area,
        );
        assert!(navigation.commands.is_empty());
        assert!(app.mode == Mode::Navigate);
        let leave = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            area,
        );
        assert!(!leave.quit);
        assert!(matches!(
            app.dialog,
            Some(Dialog::ExitConfirm {
                from_menu: false,
                leave_selected: false,
            })
        ));
        let stay = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            area,
        );
        assert!(!stay.quit);
        assert!(app.dialog.is_none());
        app.mode = Mode::Input;
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
            click(&mut app, area, Action::MenuChoice(2))
                .commands
                .is_empty()
        );
        assert!(matches!(app.dialog, Some(Dialog::Settings { .. })));
        assert!(
            click(&mut app, area, Action::SettingChoice(0))
                .commands
                .is_empty()
        );
        assert_eq!(app.theme, Theme::Graphite);
        assert!(matches!(app.dialog, Some(Dialog::Settings { .. })));
        click(&mut app, area, Action::Cancel);
        app.dialog = Some(Dialog::Menu);
        assert!(
            click(&mut app, area, Action::MenuChoice(1))
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
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('q'), KeyModifiers::CONTROL)),
            area,
        );
        let detach = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            area,
        );
        assert!(!detach.quit);
        assert!(matches!(
            app.dialog,
            Some(Dialog::ExitConfirm {
                from_menu: false,
                leave_selected: false,
            })
        ));
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)),
            area,
        );
        let confirmed = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            area,
        );
        assert!(confirmed.quit);
        assert!(detach.commands.is_empty());
    }

    #[test]
    fn escape_from_theme_returns_to_menu_and_menu_escape_confirms_exit() {
        let mut app = App::new(1);
        app.dialog = Some(Dialog::Settings { selected: 1 });
        let area = Rect::new(0, 0, 100, 30);
        let escape = Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        let back = event(&mut app, escape.clone(), area);
        assert!(!back.quit);
        assert!(back.commands.is_empty());
        assert_eq!(app.theme, Theme::Ultraviolet);
        assert!(matches!(app.dialog, Some(Dialog::Menu)));
        let detach = event(&mut app, escape, area);
        assert!(!detach.quit);
        assert!(matches!(
            app.dialog,
            Some(Dialog::ExitConfirm {
                from_menu: true,
                leave_selected: false,
            })
        ));
        let stay = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('n'), KeyModifiers::NONE)),
            area,
        );
        assert!(!stay.quit);
        assert!(matches!(app.dialog, Some(Dialog::Menu)));
        assert!(detach.commands.is_empty());
    }

    #[test]
    fn exit_modal_arrows_and_tab_choose_the_enter_action() {
        let mut app = App::new(1);
        let area = Rect::new(0, 0, 100, 30);
        let key = |app: &mut App, code| {
            event(
                app,
                Event::Key(KeyEvent::new(code, KeyModifiers::NONE)),
                area,
            )
        };
        assert!(!key(&mut app, KeyCode::Esc).quit);
        assert!(matches!(
            app.dialog,
            Some(Dialog::ExitConfirm {
                leave_selected: false,
                ..
            })
        ));
        assert!(!key(&mut app, KeyCode::Enter).quit);
        assert!(app.dialog.is_none());
        key(&mut app, KeyCode::Esc);
        key(&mut app, KeyCode::Left);
        assert!(matches!(
            app.dialog,
            Some(Dialog::ExitConfirm {
                leave_selected: true,
                ..
            })
        ));
        key(&mut app, KeyCode::Right);
        assert!(matches!(
            app.dialog,
            Some(Dialog::ExitConfirm {
                leave_selected: false,
                ..
            })
        ));
        key(&mut app, KeyCode::Tab);
        assert!(key(&mut app, KeyCode::Enter).quit);
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
        assert_eq!(app.dialog_button, Some(1));
        let cancelled = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            area,
        );
        assert!(cancelled.commands.is_empty());
        assert!(app.dialog.is_none());
        event(&mut app, Event::Key(key), area);
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE)),
            area,
        );
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
            matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.name == "W" && form.cwd.is_empty() && form.program == crate::launch::Program::Claude)
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
