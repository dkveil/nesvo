//! Input intents and host commands live here, outside rendering.
use crate::{
    input,
    launch::{Field, SessionForm},
    model::{App, Dialog, Mode, MoveTarget, RowKind, TextAction, folder_choices},
    session_kind::{Choice, Picker, SessionKind, SessionKindAction},
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
    pub clipboard: Option<String>,
    pub quit: bool,
    pub redraw: bool,
}

impl Default for Outcome {
    fn default() -> Self {
        Self {
            commands: Vec::new(),
            clipboard: None,
            quit: false,
            redraw: true,
        }
    }
}

pub fn event(app: &mut App, event: Event, area: Rect) -> Outcome {
    let event = match event {
        Event::Key(key) => Event::Key(input::normalize_key(key)),
        other => other,
    };
    // A later deliberate interaction supersedes an outstanding request to type.
    if matches!(&event, Event::Key(k) if k.kind != KeyEventKind::Release)
        || matches!(&event, Event::Mouse(m) if matches!(m.kind, MouseEventKind::Down(_) | MouseEventKind::ScrollUp | MouseEventKind::ScrollDown))
    {
        app.pending_input = None;
    }
    if app.notes.capture.is_some() {
        return crate::notes_controller::capture_event(app, event, area);
    }
    if let Event::Key(key) = &event
        && crate::notes_controller::capture_key(app, key)
    {
        crate::notes_controller::begin_capture(app, area);
        return Outcome::default();
    }
    if app.worktrees.dialog.is_some() {
        return crate::worktree_actions::event(app, event);
    }
    if app.session_kind.is_some() {
        return session_kind_event(app, event, area);
    }
    if app.layout_picker.is_some() {
        return layouts_event(app, event, area);
    }
    if app.overlay.is_some() {
        return crate::toolbox::event(app, event, area);
    }
    if app.jobs.is_some() && app.dialog.is_none() {
        return crate::jobs_controller::event(app, event);
    }
    if crate::runs_controller::engaged(app) && app.dialog.is_none() {
        return crate::runs_controller::event(app, event);
    }
    if app.projects.open && app.dialog.is_none() {
        return crate::projects_controller::event(app, event, area);
    }
    if crate::git_pane::captures(app) {
        return crate::git_pane::event(app, event);
    }
    if crate::notes_controller::captures(app) {
        return crate::notes_controller::event(app, event, area);
    }
    if crate::overview::engaged(app) && app.dialog.is_none() {
        return crate::overview::event(app, event, area);
    }
    let mut outcome = Outcome::default();
    match &event {
        Event::Key(_) | Event::Resize(..) => app.selection = None,
        Event::Mouse(mouse) if mouse.kind == MouseEventKind::Drag(MouseButton::Left) => {
            if let Some(selection) = &mut app.selection {
                crate::selection::drag(selection, *mouse);
            }
            return outcome;
        }
        Event::Mouse(mouse) if mouse.kind == MouseEventKind::Up(MouseButton::Left) => {
            if let Some(mut selection) = app.selection.take()
                && selection.dragged
            {
                crate::selection::drag(&mut selection, *mouse);
                let text = selection.text();
                if !text.is_empty() {
                    outcome.clipboard = Some(text);
                }
            }
            return outcome;
        }
        Event::Mouse(mouse) if mouse.kind == MouseEventKind::Down(MouseButton::Left) => {
            app.selection = None;
            app.selection = crate::selection::press(app, *mouse, area);
        }
        Event::Mouse(mouse)
            if matches!(
                mouse.kind,
                MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
            ) =>
        {
            app.selection = None
        }
        _ => {}
    }
    let dialog_before = app.dialog.as_ref().map(std::mem::discriminant);
    let search_was_open = matches!(app.dialog, Some(Dialog::QuickSwitch { .. }));
    match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => {
            if app.dialog.is_none()
                && (key.code == KeyCode::Char('\u{11}')
                    || (key.modifiers.contains(KeyModifiers::CONTROL)
                        && matches!(key.code, KeyCode::Char('q' | 'Q'))))
            {
                app.mode = Mode::Navigate;
                app.review.focused = false;
                app.review.return_to_input = false;
                app.reviews.focused = false;
                app.reviews.return_to_input = false;
                app.notice.clear();
            } else if key.code == KeyCode::F(1) {
                app.dialog = Some(Dialog::Menu);
            } else if app.dialog.is_none()
                && app.mode == Mode::Navigate
                && (key.code == KeyCode::Char('\u{0b}')
                    || (key.modifiers.contains(KeyModifiers::CONTROL)
                        && matches!(key.code, KeyCode::Char('k' | 'K'))))
            {
                app.mode = Mode::Navigate;
                app.palette_expanded = true;
                app.begin_palette(String::new());
            } else if app.dialog.is_some() {
                dialog_key(app, key, area, &mut outcome);
            } else if key.code == KeyCode::F(app.shortcuts.keys[0]) && key.modifiers.is_empty() {
                toggle_review(app, area, &mut outcome);
            } else if key.code == KeyCode::F(app.shortcuts.keys[1]) && key.modifiers.is_empty() {
                if let Some(id) = app
                    .recent_sessions
                    .iter()
                    .find(|id| Some(id.as_str()) != app.active_id())
                    .cloned()
                {
                    outcome.commands.extend(app.activate_session(&id));
                } else {
                    app.notice = "No previous session yet.".into();
                }
            } else if key.code == KeyCode::F(app.shortcuts.keys[2]) && key.modifiers.is_empty() {
                let next = app
                    .sessions
                    .iter()
                    .filter(|s| !s.muted && s.attention.as_ref().is_some_and(|a| a.unread))
                    .min_by_key(|s| s.attention.as_ref().map(|a| a.at))
                    .map(|s| s.id.clone());
                if let Some(id) = next {
                    outcome.commands.extend(app.activate_session(&id));
                } else {
                    app.notice = "No unread attention events.".into();
                }
            } else if key.modifiers.is_empty()
                && (key.code == KeyCode::F(app.shortcuts.keys[3])
                    || key.code == KeyCode::F(app.shortcuts.keys[4]))
            {
                let recovery = key.code == KeyCode::F(app.shortcuts.keys[4]);
                if app
                    .capabilities
                    .as_ref()
                    .is_some_and(|c| if recovery { c.recovery } else { c.templates })
                {
                    app.overlay = Some(crate::toolbox::Overlay::Recipes(recovery, 0));
                    app.notice = "Loading from host…".into();
                    outcome.commands.push(
                        json!({"type":if recovery { "listRecovery" } else { "listTemplates" }}),
                    );
                } else {
                    app.notice = "Update the host to use saved launch workflows.".into();
                }
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
            } else if app.reviews.has_focus() {
                review_tab_key(app, key, area, &mut outcome);
            } else if key.modifiers.is_empty() && matches!(key.code, KeyCode::Char('[' | ']')) {
                if app.review.visible {
                    review_key(app, key, area, &mut outcome);
                } else {
                    let width = ui::geometry(area, app).tree.width;
                    if width > 0 {
                        app.sidebar_width = if key.code == KeyCode::Char('[') {
                            width.saturating_sub(4).max(22)
                        } else {
                            width
                                .saturating_add(4)
                                .min(80)
                                .min(area.width.saturating_sub(48))
                        };
                    }
                }
            } else if app.review.visible && app.review.focused {
                review_key(app, key, area, &mut outcome);
            } else if crate::files_controller::key(app, key, area, &mut outcome) {
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
            if app.dialog.is_none()
                && app.reviews.has_focus()
                && crate::review_session::paste(app, &text)
            {
            } else if let Some(Dialog::QuickSwitch { query, selected }) = &mut app.dialog {
                let previous = query.clone();
                query.extend(
                    text.chars()
                        .filter(|c| !c.is_control())
                        .take(120usize.saturating_sub(query.chars().count())),
                );
                if *query != previous {
                    *selected = None;
                    app.select_palette(0);
                }
            } else if let Some(Dialog::FolderPicker {
                query, selected, ..
            }) = &mut app.dialog
            {
                query.extend(
                    text.chars()
                        .filter(|c| !c.is_control())
                        .take(120usize.saturating_sub(query.chars().count())),
                );
                *selected = 0;
                app.dialog_button = None;
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
            let immersive = ui::immersive(app);
            if app.dialog.is_none()
                && app.reviews.shown.is_some()
                && geometry.review.contains((mouse.column, mouse.row).into())
            {
                review_tab_mouse(app, mouse, geometry.review);
                return outcome;
            }
            if app.dialog.is_none() && geometry.review.contains((mouse.column, mouse.row).into()) {
                if !matches!(
                    mouse.kind,
                    MouseEventKind::Down(MouseButton::Left)
                        | MouseEventKind::ScrollUp
                        | MouseEventKind::ScrollDown
                ) {
                    return outcome;
                }
                app.review.focused = true;
                app.mode = Mode::Navigate;
                if matches!(
                    mouse.kind,
                    MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
                ) {
                    app.review.scroll = if mouse.kind == MouseEventKind::ScrollUp {
                        app.review.scroll.saturating_sub(3)
                    } else {
                        app.review.scroll.saturating_add(3)
                    };
                } else if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
                    let inner = ratatui::widgets::Block::bordered().inner(geometry.review);
                    let count = (app.review.data.files.len() as u16)
                        .clamp(1, 5)
                        .min(inner.height);
                    if mouse.row >= inner.y && mouse.row < inner.y + count {
                        let first = app
                            .review
                            .file
                            .saturating_sub(count.saturating_sub(1) as usize);
                        app.review.file = (first + (mouse.row - inner.y) as usize)
                            .min(app.review.data.files.len().saturating_sub(1));
                        app.review.scroll = 0;
                    }
                }
                return outcome;
            }
            if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
                if let Some(action) = ui_controls::hit_test(app, area, mouse.column, mouse.row) {
                    if app.dialog.is_none() {
                        app.review.focused = false;
                        crate::review_session::unfocus(app);
                    }
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
                    app.move_palette(up);
                } else if app.dialog.is_none() {
                    if crate::files_controller::sidebar_shows_files(app)
                        && ui::tree_content(geometry.tree)
                            .contains((mouse.column, mouse.row).into())
                    {
                        crate::files_controller::scroll(app, up);
                    } else if ui::tree_content(geometry.tree)
                        .contains((mouse.column, mouse.row).into())
                    {
                        app.selected = if up {
                            app.selected
                                .saturating_sub(1)
                                .max(usize::from(app.tree().len() > 1))
                        } else {
                            (app.selected + 1).min(app.tree().len().saturating_sub(1))
                        };
                        preview_selected_session(app, &mut outcome);
                    } else if let Some(index) = (0..app.leaf_count()).find(|index| {
                        geometry.panes[*index].contains((mouse.column, mouse.row).into())
                    }) && let Some(id) = app.panes[index].as_ref()
                        && let Some(terminal) = app.terminals.get_mut(id)
                    {
                        let pane = ui::pane_content(geometry.panes[index], immersive);
                        let id = id.clone();
                        let encoded = input::encode_wheel(
                            terminal.screen(),
                            up,
                            mouse.column.saturating_sub(pane.x),
                            mouse.row.saturating_sub(pane.y),
                        );
                        if let Some(data) = encoded {
                            if app.owns(&id) {
                                outcome.commands.push(json!({"type":"input", "sessionId":id,
                                    "leaseId":app.leases.get(&id), "data":data}));
                            } else {
                                app.notice =
                                    "Read-only: acquire control to scroll this application's view."
                                        .into();
                            }
                        } else {
                            terminal.scroll(if up { 3 } else { -3 });
                        }
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
    if !search_was_open && matches!(app.dialog, Some(Dialog::QuickSwitch { .. })) && app.connected {
        outcome.commands.push(json!({"type":"list"}));
    }
    app.reconcile_palette();
    if let Some(Dialog::QuickSwitch { selected, .. }) = &app.dialog {
        let id = selected
            .as_ref()
            .and_then(|target| target.session_id().map(str::to_owned));
        if let Some(id) = id
            && (app.active_id() != Some(id.as_str()) || !app.subscribed.contains(&id))
        {
            outcome.commands.extend(app.preview_session(&id));
        }
    }
    if app.review.visible
        && app
            .active_id()
            .is_some_and(|id| id != app.review.session_id)
        && let Some(command) = app.request_diff()
    {
        outcome.commands.push(command);
    }
    if !matches!(app.dialog, Some(Dialog::QuickSwitch { .. }))
        && app.reviews.picking.take().is_some()
    {
        app.notice.clear();
    }
    outcome.commands.extend(crate::files_controller::sync(app));
    outcome.commands.extend(crate::notes_controller::sync(app));
    outcome
        .commands
        .extend(crate::projects_controller::sync(app));
    outcome.commands.extend(crate::worktree_actions::sync(app));
    for command in &outcome.commands {
        if command["type"] == "acquireControl" {
            app.pending_input = command["sessionId"].as_str().map(str::to_owned);
        }
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
                KeyEvent::new(
                    if key == 'D' {
                        KeyCode::F(4)
                    } else {
                        KeyCode::Char(key)
                    },
                    KeyModifiers::NONE,
                ),
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
            if let Some(Dialog::NewSession(form)) = &mut app.dialog
                && form.programs().contains(&program)
            {
                if form.program != program {
                    form.effort.clear();
                }
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
        Action::PaletteCategory(index) => {
            app.palette_category = index;
            app.select_palette(0);
        }
        Action::QuickChoice(index) => {
            app.select_palette(index);
        }
        Action::FocusMenu => {
            app.mode = Mode::Navigate;
            app.review.focused = false;
            app.pending_input = None;
        }
        Action::FocusSearch => {
            if !matches!(app.dialog, Some(Dialog::QuickSwitch { .. })) {
                app.mode = Mode::Navigate;
                app.palette_expanded = false;
                app.palette_category = 0;
                app.begin_palette(String::new());
            }
        }
        Action::OpenRow(index) => {
            app.selected = index;
            if let Some(row) = app.selected_row() {
                match row.kind {
                    RowKind::Session(id) => outcome.commands.extend(app.activate_session(&id)),
                    RowKind::Group(id) => {
                        app.mode = Mode::Navigate;
                        toggle_group(app, id);
                    }
                    RowKind::Root => {}
                }
            }
        }
        Action::FocusPane(index) => {
            app.focused = index;
            if let Some(id) = app.panes[index].clone() {
                outcome.commands.extend(app.activate_session(&id));
            }
        }
        Action::FocusTab(index) => {
            if let Some(id) = app.tabs.get(index).cloned() {
                outcome.commands.extend(app.activate_session(&id));
            } else if let Some(review) = index.checked_sub(app.tabs.len()) {
                crate::review_session::show(app, review, true);
                outcome.commands.extend(crate::review_session::pump(app));
            }
        }
        Action::MenuChoice(index) => menu_choice(app, index, outcome),
    }
}

fn dialog_key(app: &mut App, key: KeyEvent, area: Rect, outcome: &mut Outcome) {
    if matches!(app.dialog, Some(Dialog::Help))
        && matches!(key.code, KeyCode::Left | KeyCode::Right)
    {
        app.help_page = (app.help_page
            + if matches!(key.code, KeyCode::Left) {
                2
            } else {
                1
            })
            % 3;
        app.dialog_button = None;
        return;
    }
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
            KeyCode::Up | KeyCode::BackTab => app.menu_selected = (app.menu_selected + 3) % 4,
            KeyCode::Down | KeyCode::Tab => app.menu_selected = (app.menu_selected + 1) % 4,
            KeyCode::Enter => menu_choice(app, app.menu_selected, outcome),
            KeyCode::Char('1'..='4') => {
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
        let results = app.palette_results(query);
        let index = selected
            .as_ref()
            .and_then(|target| results.iter().position(|row| &row.target == target));
        let mut next_query = query.clone();
        let mut next_selected = selected.clone();
        let mut reset_selection = false;
        match key.code {
            KeyCode::Enter => {
                open_quick_choice(app, area, outcome);
                return;
            }
            KeyCode::Up | KeyCode::Char('p')
                if key.code == KeyCode::Up || key.modifiers.contains(KeyModifiers::CONTROL) =>
            {
                next_selected = results
                    .get(index.map_or(results.len().saturating_sub(1), |index| {
                        index.saturating_sub(1)
                    }))
                    .map(|row| row.target.clone());
            }
            KeyCode::F(2) => app.palette_expanded = true,
            KeyCode::Tab if app.palette_expanded => {
                app.palette_category = (app.palette_category + 1) % 4;
                reset_selection = true;
            }
            KeyCode::BackTab if app.palette_expanded => {
                app.palette_category = (app.palette_category + 3) % 4;
                reset_selection = true;
            }
            KeyCode::Tab => app.palette_expanded = true,
            KeyCode::Down | KeyCode::Char('n')
                if key.code == KeyCode::Down || key.modifiers.contains(KeyModifiers::CONTROL) =>
            {
                next_selected = results
                    .get(index.map_or(0, |index| (index + 1).min(results.len().saturating_sub(1))))
                    .map(|row| row.target.clone());
            }
            KeyCode::Backspace => {
                next_query.pop();
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                next_query.clear();
            }
            KeyCode::Char(c)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                    && !c.is_control()
                    && next_query.chars().count() < 120 =>
            {
                next_query.push(c);
            }
            _ => {}
        }
        reset_selection |= next_query != *query;
        app.dialog = Some(Dialog::QuickSwitch {
            query: next_query,
            selected: next_selected,
        });
        if reset_selection {
            app.select_palette(0);
        }
        return;
    }
    if matches!(app.dialog, Some(Dialog::Confirm { .. })) && app.dialog_button.is_none() {
        app.dialog_button = Some(1);
    }
    if key.code == KeyCode::F(2) && matches!(app.dialog, Some(Dialog::FolderPicker { .. })) {
        submit_focused_dialog(app, outcome);
        return;
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
                    let profiles = form.profile_efforts(app.capabilities.as_ref()).is_some();
                    form.field = form.last_field(profiles);
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
            KeyCode::Char('k') => {
                app.notice.clear();
                app.overlay = Some(crate::toolbox::Overlay::Shortcuts(0, false));
            }
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
    if let Some(Dialog::NewSession(form)) = &mut app.dialog {
        if key.code == KeyCode::F(3) {
            if !app.capabilities.as_ref().is_some_and(|c| c.templates) {
                app.notice = "Update the host to save templates.".into();
            } else if form.name.trim().is_empty() {
                app.notice = "Enter a name for this template first.".into();
            } else {
                outcome.commands.push(json!({"type":"saveTemplate", "name":form.name.trim(), "spec":{
                    "name":form.name.trim(),"cwd":form.cwd.trim(),"program":form.program,"groupId":form.group_id,
                    "prompt":form.prompt,"worktree":form.worktree
                }}));
                app.notice = "Saving launch template…".into();
            }
            return;
        }
        if key.code == KeyCode::F(2) && form.kind == Some(SessionKind::Terminal) {
            return;
        }
        if key.code == KeyCode::F(2) {
            form.advanced = !form.advanced;
            form.field = if form.advanced {
                Field::Worktree
            } else {
                Field::Name
            };
            app.dialog_button = None;
            return;
        }
        if form.advanced {
            match key.code {
                KeyCode::Tab | KeyCode::Down => match form.field {
                    Field::Worktree => form.field = Field::Prompt,
                    Field::Prompt => form.field = Field::When,
                    _ => app.dialog_button = Some(0),
                },
                KeyCode::BackTab | KeyCode::Up => {
                    form.field = if form.field == Field::When {
                        Field::Prompt
                    } else {
                        Field::Worktree
                    }
                }
                KeyCode::Left | KeyCode::Right | KeyCode::Char(' ') | KeyCode::Enter
                    if form.field == Field::Worktree =>
                {
                    form.worktree = !form.worktree
                }
                KeyCode::Enter if form.field == Field::Prompt => form.field = Field::When,
                KeyCode::Enter => {
                    if let Some(command) = app.submit_dialog() {
                        outcome.commands.push(command);
                    }
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
            }
            return;
        }
    }
    let mut submit = false;
    let mut browse = false;
    let mut directory_path = None;
    let mut selected_folder = None;
    let mut close = false;
    let efforts = match &app.dialog {
        Some(Dialog::NewSession(form)) => form.profile_efforts(app.capabilities.as_ref()),
        _ => None,
    };
    let profiles = efforts.is_some();
    match &mut app.dialog {
        Some(Dialog::NewSession(form)) => {
            if !profiles && matches!(form.field, Field::Model | Field::Effort) {
                form.field = Field::Program;
            }
            let programs = form.programs();
            match key.code {
                KeyCode::Tab | KeyCode::Down
                    if matches!(form.field, Field::Name | Field::Directory | Field::Model) =>
                {
                    match form.next_field(profiles) {
                        Some(field) => form.field = field,
                        None => app.dialog_button = Some(0),
                    }
                }
                KeyCode::Tab | KeyCode::Down if form.field == Field::Effort => {
                    app.dialog_button = Some(0)
                }
                KeyCode::Tab if form.field == Field::Program => match form.next_field(profiles) {
                    Some(field) => form.field = field,
                    None => app.dialog_button = Some(0),
                },
                KeyCode::BackTab | KeyCode::Up
                    if matches!(form.field, Field::Directory | Field::Model | Field::Effort) =>
                {
                    form.field = form.previous_field()
                }
                KeyCode::BackTab if form.field == Field::Program => form.field = Field::Directory,
                KeyCode::Down
                    if form.field == Field::Program && programs.last() == Some(&form.program) =>
                {
                    match form.next_field(profiles) {
                        Some(field) => form.field = field,
                        None => app.dialog_button = Some(0),
                    }
                }
                KeyCode::Up
                    if form.field == Field::Program && programs.first() == Some(&form.program) =>
                {
                    form.field = Field::Directory
                }
                KeyCode::Up | KeyCode::Left if form.field == Field::Program => {
                    form.cycle_program(true)
                }
                KeyCode::Down | KeyCode::Right if form.field == Field::Program => {
                    form.cycle_program(false)
                }
                KeyCode::Left | KeyCode::Right if form.field == Field::Effort => form.cycle_effort(
                    efforts.as_deref().unwrap_or_default(),
                    key.code == KeyCode::Left,
                ),
                KeyCode::Enter if form.field == Field::Name => form.field = Field::Directory,
                KeyCode::Enter if form.field == Field::Model => form.field = Field::Effort,
                KeyCode::Enter if form.field == Field::Directory => browse = true,
                KeyCode::Enter => submit = true,
                KeyCode::Backspace => form.backspace(),
                KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    match form.field {
                        Field::Name => form.name.clear(),
                        Field::Model => form.model.clear(),
                        _ => {}
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
            }
        }
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
            path,
            parent,
            entries,
            query,
            selected,
            loading,
            ..
        }) => {
            let choices = folder_choices(parent, entries, query);
            match key.code {
                KeyCode::Tab => app.dialog_button = Some(0),
                KeyCode::Up => *selected = selected.saturating_sub(1),
                KeyCode::Down if *selected + 1 >= choices.len() => app.dialog_button = Some(0),
                KeyCode::Down => *selected += 1,
                KeyCode::Enter if !*loading => {
                    selected_folder = choices.get(*selected).map(|(_, path)| (*path).to_owned());
                    if choices.is_empty() && query.is_empty() {
                        selected_folder = Some(path.clone());
                    }
                }
                KeyCode::Right if !*loading => {
                    if !(query.is_empty() && parent.is_some() && *selected == 0) {
                        directory_path = choices.get(*selected).map(|(_, path)| (*path).to_owned());
                    }
                }
                KeyCode::Left if !*loading => directory_path = parent.clone(),
                KeyCode::Backspace => {
                    query.pop();
                    *selected = 0;
                }
                KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    query.clear();
                    *selected = 0;
                }
                KeyCode::Char(c)
                    if !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                        && !c.is_control()
                        && query.chars().count() < 120 =>
                {
                    query.push(c);
                    *selected = 0;
                }
                _ => {}
            }
        }
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
    if let Some(path) = directory_path {
        browse_directory(app, path, outcome);
    }
    if let Some(path) = selected_folder {
        select_folder(app, path);
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
            | Dialog::Help
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
        if let Some(Dialog::FolderPicker {
            path,
            loading: false,
            ..
        }) = &app.dialog
        {
            select_folder(app, path.clone());
        }
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
        query: String::new(),
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
        query,
        loading,
        ..
    }) = &app.dialog
    else {
        return;
    };
    if *loading {
        return;
    }
    let target = folder_choices(parent, entries, query)
        .get(index)
        .map(|(_, path)| (*path).to_owned());
    if let Some(path) = target {
        browse_directory(app, path, outcome);
    }
}

fn browse_directory(app: &mut App, path: String, outcome: &mut Outcome) {
    app.dialog_button = None;
    outcome.commands.push(app.browse_directory(path));
}

fn select_folder(app: &mut App, path: String) {
    let Some(Dialog::FolderPicker { mut form, .. }) = app.dialog.take() else {
        return;
    };
    form.cwd = path;
    form.field = Field::Directory;
    app.pending_directory_cancel();
    app.dialog = Some(Dialog::NewSession(form));
    app.dialog_button = None;
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
        3 => app.dialog = Some(Dialog::Help),
        _ => {}
    }
}

fn open_quick_choice(app: &mut App, area: Rect, outcome: &mut Outcome) {
    app.reconcile_palette();
    let Some(Dialog::QuickSwitch { selected, .. }) = &app.dialog else {
        return;
    };
    let target = selected.clone();
    let Some(target) = target else {
        app.notice = "Choose a search result before opening it.".into();
        return;
    };
    app.dialog = None;
    if let (Some(review_id), crate::palette::Target::Session(id)) =
        (app.reviews.picking.take(), &target)
    {
        app.notice.clear();
        outcome
            .commands
            .extend(crate::review_session::deliver(app, &review_id, id));
        if let Some(index) = app.reviews.by_id(&review_id) {
            crate::review_session::show(app, index, true);
        }
        return;
    }
    match target {
        crate::palette::Target::Session(id) => outcome.commands.extend(app.activate_session(&id)),
        crate::palette::Target::Group(id) => {
            let mut parent = Some(id.clone());
            let mut seen = std::collections::HashSet::new();
            while let Some(next) = parent {
                if !seen.insert(next.clone()) {
                    break;
                }
                app.collapsed.remove(&next);
                parent = app
                    .groups
                    .iter()
                    .find(|g| g.id == next)
                    .and_then(|g| g.parent_id.clone());
            }
            app.selected = app
                .tree()
                .iter()
                .position(|row| row.kind == RowKind::Group(id.clone()))
                .unwrap_or(0);
        }
        crate::palette::Target::Command('D') => toggle_review(app, area, outcome),
        crate::palette::Target::Command('F') => crate::files_controller::toggle_mode(app),
        crate::palette::Target::File(path) => crate::files_controller::open_found(app, &path),
        crate::palette::Target::Project(root) => {
            crate::projects_controller::reveal(app, &root, outcome)
        }
        crate::palette::Target::Command(key) => navigation_key(
            app,
            KeyEvent::new(
                if key == 'D' {
                    KeyCode::F(4)
                } else {
                    KeyCode::Char(key)
                },
                KeyModifiers::NONE,
            ),
            Rect::new(0, 0, 80, 24),
            outcome,
        ),
    }
}

fn change_setting(app: &mut App, index: usize, _reverse: bool) {
    match index {
        0 => {
            let selected = Theme::ALL
                .iter()
                .position(|theme| *theme == app.theme)
                .unwrap_or(0);
            app.overlay = Some(crate::toolbox::Overlay::Themes(selected, app.theme));
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
            app.palette_expanded = true;
            app.begin_palette(String::new());
        }
        return;
    }
    match key.code {
        KeyCode::Char('/' | '\u{0b}') => {
            app.palette_expanded = true;
            app.palette_category = 0;
            app.begin_palette(String::new())
        }
        KeyCode::Char('w') => {
            if let Some(session) = app.active_session()
                && (app.wake_available() || session.wake_at.is_some())
            {
                app.dialog = Some(crate::overview::wake_confirm(session));
            }
        }
        KeyCode::Char('H') => app.overlay = Some(crate::toolbox::Overlay::Onboarding(0)),
        KeyCode::Char('f') => app.overlay = Some(crate::toolbox::Overlay::Filters(0)),
        KeyCode::Char('S') => {
            if !app.capabilities.as_ref().is_some_and(|caps| caps.schedules) {
                app.notice = "Update the host to manage scheduled sessions.".into();
                return;
            }
            app.overlay = Some(crate::toolbox::Overlay::Schedules(0));
            outcome.commands.push(json!({"type":"listSchedules"}));
        }
        KeyCode::Char('J') => crate::jobs_controller::open(app, outcome),
        KeyCode::Char('W') => crate::runs_controller::open(app, outcome),
        KeyCode::Char('P') => crate::projects_controller::open(app, outcome),
        KeyCode::Char('K') => crate::worktree_actions::open(app),
        KeyCode::Char('O') => crate::overview::open(app, area.width),
        KeyCode::Char('Y') => outcome.commands.extend(crate::git_pane::open(app, true)),
        KeyCode::Char('T') => outcome
            .commands
            .extend(crate::notes_controller::open(app, true)),
        KeyCode::Tab if app.reviews.shown.is_some() => app.reviews.focused = true,
        KeyCode::Tab if app.review.visible => app.review.focused = true,
        KeyCode::Char('q') => outcome.quit = true,
        KeyCode::Char('z') => app.fullscreen = !app.fullscreen,
        KeyCode::Char('?') => app.dialog = Some(Dialog::Help),
        KeyCode::Char('M') => app.dialog = Some(Dialog::Menu),
        KeyCode::Char('p') => app.dialog = Some(Dialog::PairPhone),
        KeyCode::Up | KeyCode::Char('k') => {
            app.selected = app.selected.saturating_sub(1);
            if app.selected == 0 {
                app.palette_expanded = false;
                app.palette_category = 0;
                app.begin_palette(String::new());
            }
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
            app.focus_next(key.code == KeyCode::BackTab);
        }
        KeyCode::Char('L') => crate::layouts::open(app),
        KeyCode::Char('v') => {
            app.pane_layout = None;
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
                app.clear_hidden_panes();
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
        KeyCode::Char('N') => {
            app.dialog = None;
            app.dialog_button = None;
            app.session_kind = Some(Picker::default());
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
        KeyCode::Char('u') => {
            if let Some(session) = app
                .active_session()
                .filter(|_| app.capabilities.as_ref().is_some_and(|c| c.attention))
            {
                outcome.commands.push(
                    json!({"type":"muteSession","sessionId":session.id,"muted":!session.muted}),
                );
            }
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

fn layouts_event(app: &mut App, event: Event, area: Rect) -> Outcome {
    let mut outcome = Outcome::default();
    match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => {
            outcome.commands = crate::layouts::key(app, key, area.width);
        }
        Event::Paste(text) => crate::layouts::paste(app, &text),
        Event::Resize(..) => {}
        _ => outcome.redraw = false,
    }
    outcome
}

fn session_kind_event(app: &mut App, event: Event, area: Rect) -> Outcome {
    let mut outcome = Outcome::default();
    let Some(picker) = app.session_kind.as_mut() else {
        return outcome;
    };
    let action = match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => picker.action(key),
        Event::Paste(text) => {
            picker.paste(&text);
            None
        }
        Event::Mouse(mouse) if mouse.kind == MouseEventKind::Down(MouseButton::Left) => {
            crate::ui_session_kind::row_at(area, picker, mouse.column, mouse.row)
                .map(SessionKindAction::Pick)
        }
        Event::Resize(..) | Event::Key(_) => None,
        _ => {
            outcome.redraw = false;
            None
        }
    };
    if let Some(action) = action {
        let choice = picker.apply(action);
        apply_session_kind(app, choice, &mut outcome);
    }
    outcome
}

fn apply_session_kind(app: &mut App, choice: Choice, outcome: &mut Outcome) {
    if choice == Choice::Pending {
        return;
    }
    app.session_kind = None;
    if !matches!(choice, Choice::Kind(_)) {
        app.projects.launch_folder = None;
    }
    match choice {
        Choice::Pending | Choice::Closed => {}
        Choice::Kind(kind) => open_session_form(app, kind),
        Choice::LocalChanges => open_local_review(app, outcome),
        Choice::PullRequest(url) => outcome.commands.extend(crate::review_session::open(
            app,
            crate::review_session::Source::Pull(url),
        )),
    }
}

fn open_session_form(app: &mut App, kind: SessionKind) {
    let hint = app
        .active_session()
        .map(|session| app.effective_program(session));
    let agent = crate::session_kind::agent_program(hint, |program| {
        app.capabilities
            .as_ref()
            .is_some_and(|caps| caps.available(program))
    });
    let group_id = app.selected_group();
    let form = kind.preset(
        group_id,
        agent,
        app.sessions.iter().map(|session| session.name.as_str()),
    );
    let folder = app.projects.launch_folder.take();
    if let Some(mut form) = form {
        if let Some(folder) = folder {
            form.cwd = folder;
        }
        app.dialog = Some(Dialog::NewSession(form));
        app.dialog_button = None;
        app.notice.clear();
    }
}

fn open_local_review(app: &mut App, outcome: &mut Outcome) {
    let Some(id) = app.review_candidate().map(|session| session.id.clone()) else {
        app.notice = "Select a session to review its local changes.".into();
        return;
    };
    if crate::review_session::supported(app) {
        outcome.commands.extend(crate::review_session::open(
            app,
            crate::review_session::Source::Local(id),
        ));
        return;
    }
    if app.active_id() != Some(id.as_str()) {
        outcome.commands.extend(app.open_session(&id));
    }
    app.review.return_to_input = false;
    app.review.focused = true;
    if let Some(command) = app.request_diff() {
        outcome.commands.push(command);
    }
    app.mode = Mode::Navigate;
}

fn review_tab_key(app: &mut App, key: KeyEvent, area: Rect, outcome: &mut Outcome) {
    let rect = ui::geometry(area, app).review;
    app.reviews.area = rect;
    let page = app
        .reviews
        .active()
        .map_or(1, |tab| crate::ui_review::page(rect, tab));
    let result = crate::review_session::key(app, key, page);
    outcome.commands.extend(result.commands);
    if result.clipboard.is_some() {
        outcome.clipboard = result.clipboard;
    }
}

fn review_tab_mouse(app: &mut App, mouse: crossterm::event::MouseEvent, rect: Rect) {
    match mouse.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            app.review.focused = false;
            app.reviews.focused = true;
            app.reviews.return_to_input = false;
            app.mode = Mode::Navigate;
            let hit = app
                .reviews
                .active()
                .and_then(|tab| crate::ui_review::hit(tab, rect, mouse.column, mouse.row));
            if let Some(hit) = hit {
                crate::review_session::click(app, hit);
            }
        }
        MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
            crate::review_session::scroll(app, mouse.kind == MouseEventKind::ScrollUp)
        }
        _ => {}
    }
}

fn toggle_review(app: &mut App, area: Rect, outcome: &mut Outcome) {
    if app.reviews.shown.is_some() {
        crate::review_session::hide(app);
        return;
    }
    if !app.review.visible
        && crate::review_session::supported(app)
        && ui::content_width(area, app) >= crate::review_session::DOCK_COLUMNS
    {
        match app.active_id().map(str::to_owned) {
            Some(id) => outcome.commands.extend(crate::review_session::open(
                app,
                crate::review_session::Source::Local(id),
            )),
            None => app.notice = "Open a session to review its changes.".into(),
        }
        return;
    }
    if app.review.visible {
        app.review.visible = false;
        app.review.focused = false;
        if app.review.return_to_input {
            app.mode = Mode::Input;
        }
    } else {
        app.review.return_to_input = app.mode == Mode::Input;
        app.review.focused = true;
        if let Some(command) = app.request_diff() {
            outcome.commands.push(command);
        }
        if app.review.visible {
            app.mode = Mode::Navigate;
        }
    }
}

fn review_key(app: &mut App, key: KeyEvent, area: Rect, outcome: &mut Outcome) {
    if matches!(key.code, KeyCode::Char('[' | ']')) && app.review.width == 0 {
        app.review.width = ui::geometry(area, app).review.width;
    }
    if key.code == KeyCode::Char('y') {
        if let Some(file) = app.review.data.files.get(app.review.file) {
            outcome.clipboard = Some(file.patch.clone());
        }
        return;
    }
    if key.code == KeyCode::Char('a') {
        app.review.directory = None;
        app.review.data = Default::default();
        if let Some(command) = app.request_diff() {
            outcome.commands.push(command);
        }
        return;
    }
    if key.code == KeyCode::Char('o') {
        app.dialog = Some(Dialog::Text {
            title: "Pin review folder · empty = Auto".into(),
            value: app.review.directory.clone().unwrap_or_else(|| {
                app.active_session()
                    .map_or(String::new(), |s| s.cwd.clone())
            }),
            action: TextAction::ReviewDirectory,
        });
        return;
    }
    let review = &mut app.review;
    match key.code {
        KeyCode::Esc => {
            review.visible = false;
            review.focused = false;
            if review.return_to_input {
                app.mode = Mode::Input;
            }
        }
        KeyCode::Tab => review.focused = false,
        KeyCode::Up => {
            review.file = review.file.saturating_sub(1);
            review.scroll = 0;
            review.hunk = 0;
        }
        KeyCode::Down => {
            review.file = (review.file + 1).min(review.data.files.len().saturating_sub(1));
            review.scroll = 0;
            review.hunk = 0;
        }
        KeyCode::Left => review.hunk = review.hunk.saturating_sub(1),
        KeyCode::Right => {
            let count = review.data.files.get(review.file).map_or(0, |f| {
                f.patch.lines().filter(|l| l.starts_with("@@")).count()
            });
            review.hunk = (review.hunk + 1).min(count.saturating_sub(1));
        }
        KeyCode::Char(' ') => review.toggle_hunk(),
        KeyCode::PageDown => review.scroll = review.scroll.saturating_add(10),
        KeyCode::PageUp => review.scroll = review.scroll.saturating_sub(10),
        KeyCode::Char(']') => {
            review.width = (if review.width == 0 { 40 } else { review.width })
                .saturating_sub(8)
                .max(28)
        }
        KeyCode::Char('[') => {
            review.width = (if review.width == 0 { 40 } else { review.width })
                .saturating_add(8)
                .min(160)
        }
        KeyCode::Char('e') => review.expanded = !review.expanded,
        KeyCode::Char('s') => review.side_by_side = !review.side_by_side,
        KeyCode::Char('r' | 'c') => {
            if key.code == KeyCode::Char('c') {
                review.scope = (review.scope + 1) % 3;
                review.file = 0;
                review.scroll = 0;
                review.folded.clear();
            }
            if let Some(command) = app.request_diff() {
                outcome.commands.push(command);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::MouseEvent;

    fn stable_search_snapshot() -> Value {
        json!({"type":"sessions","revision":1,"groups":[{"id":"g","name":"工程","parentId":null,"order":0}],"sessions":[
            {"id":"anchor","name":"Anchor","cwd":"/repo","program":"claude","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null},
            {"id":"b","name":"工程 duplicate","cwd":"/repo","program":"claude","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null},
            {"id":"c","name":"工程 duplicate","cwd":"/repo","program":"claude","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})
    }

    fn stable_search_app(query: &str, target: crate::palette::Target) -> App {
        let mut app = App::new(1);
        app.event(stable_search_snapshot()).unwrap();
        app.palette_expanded = true;
        app.dialog = Some(Dialog::QuickSwitch {
            query: query.into(),
            selected: Some(target),
        });
        app
    }

    fn search_target(app: &App) -> Option<crate::palette::Target> {
        match &app.dialog {
            Some(Dialog::QuickSwitch { selected, .. }) => selected.clone(),
            _ => None,
        }
    }

    fn search_key(app: &mut App, code: KeyCode) -> Outcome {
        event(
            app,
            Event::Key(KeyEvent::new(code, KeyModifiers::NONE)),
            Rect::new(0, 0, 150, 44),
        )
    }

    #[test]
    fn search_opens_the_saved_identity_after_insert_reorder_rename_and_attention_changes() {
        let target = crate::palette::Target::Session("b".into());
        let mut app = stable_search_app("", target.clone());
        let before = app.palette_index();
        let mut update = stable_search_snapshot();
        update["revision"] = json!(2);
        update["sessions"][1]["name"] = json!("ZZ renamed");
        update["sessions"][2]["status"] = json!({"state":"question","source":"hook","updatedAt":2});
        let inserted = json!({"id":"new","name":"AAA inserted","cwd":"/repo","program":"codex","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null});
        update["sessions"].as_array_mut().unwrap().reverse();
        update["sessions"]
            .as_array_mut()
            .unwrap()
            .insert(0, inserted);
        app.event(update).unwrap();
        assert_eq!(search_target(&app), Some(target));
        assert_ne!(app.palette_index(), before);
        assert_eq!(app.active_id(), Some("anchor"));
        assert!(app.recent_sessions.is_empty());
        let outcome = search_key(&mut app, KeyCode::Enter);
        assert_eq!(app.active_id(), Some("b"));
        assert_eq!(app.recent_sessions.first().map(String::as_str), Some("b"));
        assert!(
            outcome
                .commands
                .iter()
                .any(|command| command["type"] == "acquireControl" && command["sessionId"] == "b")
        );
    }

    fn repository_search_snapshot() -> Value {
        let mut value = stable_search_snapshot();
        for index in [1, 2] {
            value["sessions"][index]["repositoryContext"] = json!({
                "source":"launchDirectory", "state":"ready", "name":"répertoire",
                "branch":"feature/zażółć", "observedAt":7, "revision":1
            });
        }
        value
    }

    #[test]
    fn repository_updates_preserve_the_exact_search_target_at_the_same_workspace_revision() {
        let target = crate::palette::Target::Session("b".into());
        let mut app = App::new(1);
        app.event(repository_search_snapshot()).unwrap();
        app.dialog = Some(Dialog::QuickSwitch {
            query: "feature/zażółć".into(),
            selected: Some(target.clone()),
        });
        let mut update = repository_search_snapshot();
        update["sessions"][2]["repositoryContext"]["revision"] = json!(2);
        update["sessions"][2]["repositoryContext"]["name"] = json!("other repository");
        update["sessions"].as_array_mut().unwrap().reverse();
        app.event(update).unwrap();
        assert_eq!(app.revision, 1);
        assert_eq!(search_target(&app), Some(target.clone()));
        let focus = app.focused;
        let expanded = search_key(&mut app, KeyCode::F(2));
        assert_eq!(search_target(&app), Some(target));
        assert_eq!(app.focused, focus);
        assert!(
            matches!(&app.dialog, Some(Dialog::QuickSwitch { query, .. }) if query == "feature/zażółć")
        );
        assert!(
            expanded
                .commands
                .iter()
                .all(|command| command["type"] != "list")
        );
        search_key(&mut app, KeyCode::Enter);
        assert_eq!(app.active_id(), Some("b"));
        assert_eq!(app.recent_sessions, ["b"]);
    }

    #[test]
    fn lost_repository_only_match_clears_target_without_selecting_a_matching_sibling() {
        for loss in ["stale", "unavailable", "changed", "omitted", "invalid"] {
            let mut app = App::new(1);
            app.event(repository_search_snapshot()).unwrap();
            app.dialog = Some(Dialog::QuickSwitch {
                query: "feature/zażółć".into(),
                selected: Some(crate::palette::Target::Session("b".into())),
            });
            let mut update = repository_search_snapshot();
            if loss == "omitted" {
                update["sessions"][1]
                    .as_object_mut()
                    .unwrap()
                    .remove("repositoryContext");
            } else {
                let context = &mut update["sessions"][1]["repositoryContext"];
                match loss {
                    "stale" | "unavailable" => {
                        context["state"] = json!(loss);
                        context["name"] = Value::Null;
                        context["branch"] = Value::Null;
                        if loss == "unavailable" {
                            context["observedAt"] = Value::Null;
                        }
                    }
                    "changed" => context["branch"] = json!("feature/other"),
                    "invalid" => context["revision"] = json!(-1),
                    _ => unreachable!(),
                }
            }
            app.event(update).unwrap();
            assert_eq!(app.revision, 1);
            assert_eq!(search_target(&app), None, "Context loss {loss}");
            assert!(
                app.palette_results("feature/zażółć")
                    .iter()
                    .any(|row| row.target.session_id() == Some("c"))
            );
            // Even later restored evidence does not substitute or resurrect the old cursor.
            app.event(repository_search_snapshot()).unwrap();
            search_key(&mut app, KeyCode::F(2));
            let outcome = search_key(&mut app, KeyCode::Enter);
            assert_eq!(app.active_id(), Some("anchor"));
            assert_eq!(search_target(&app), None);
            assert!(app.recent_sessions.is_empty());
            assert!(
                outcome
                    .commands
                    .iter()
                    .all(|command| command["type"] != "acquireControl")
            );
        }
    }

    #[test]
    fn deliberate_search_entry_requests_one_list_but_typing_paste_and_f2_do_not() {
        let mut app = App::new(1);
        app.event(repository_search_snapshot()).unwrap();
        let opened = search_key(&mut app, KeyCode::Char('/'));
        assert_eq!(
            opened
                .commands
                .iter()
                .filter(|command| command["type"] == "list")
                .count(),
            1
        );
        for key in [
            KeyCode::Char('z'),
            KeyCode::Backspace,
            KeyCode::F(2),
            KeyCode::Down,
        ] {
            let outcome = search_key(&mut app, key);
            assert!(
                outcome
                    .commands
                    .iter()
                    .all(|command| command["type"] != "list")
            );
        }
        let pasted = event(
            &mut app,
            Event::Paste("工程".into()),
            Rect::new(0, 0, 150, 44),
        );
        assert!(
            pasted
                .commands
                .iter()
                .all(|command| command["type"] != "list")
        );
        search_key(&mut app, KeyCode::Esc);
        let reopened = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL)),
            Rect::new(0, 0, 150, 44),
        );
        assert_eq!(
            reopened
                .commands
                .iter()
                .filter(|command| command["type"] == "list")
                .count(),
            1
        );
        search_key(&mut app, KeyCode::Esc);
        app.disconnect("offline".into());
        assert!(
            search_key(&mut app, KeyCode::Char('/'))
                .commands
                .iter()
                .all(|command| command["type"] != "list")
        );
    }

    #[test]
    fn repository_metadata_does_not_take_control_k_away_from_the_owned_pty() {
        let mut app = App::new(1);
        let mut value = repository_search_snapshot();
        value["sessions"][0]["controllerId"] = json!(1);
        app.event(value).unwrap();
        app.leases.insert("anchor".into(), "owned".into());
        app.terminals
            .insert("anchor".into(), crate::terminal::TerminalState::new(24, 80));
        app.mode = Mode::Input;
        let outcome = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL)),
            Rect::new(0, 0, 150, 44),
        );
        assert!(app.dialog.is_none());
        assert!(matches!(app.mode, Mode::Input));
        assert_eq!(
            outcome.commands,
            [json!({"type":"input","sessionId":"anchor","leaseId":"owned","data":"\u{000b}"})]
        );
    }

    #[test]
    fn search_deleted_target_is_not_replaced_even_when_its_id_reappears() {
        let mut app = stable_search_app("工程", crate::palette::Target::Session("b".into()));
        let mut update = stable_search_snapshot();
        update["sessions"]
            .as_array_mut()
            .unwrap()
            .retain(|session| session["id"] != "b");
        app.event(update).unwrap();
        assert_eq!(search_target(&app), None);
        app.event(stable_search_snapshot()).unwrap();
        search_key(&mut app, KeyCode::F(2));
        let outcome = search_key(&mut app, KeyCode::Enter);
        assert_eq!(app.active_id(), Some("anchor"));
        assert!(app.recent_sessions.is_empty());
        assert!(matches!(
            app.dialog,
            Some(Dialog::QuickSwitch { selected: None, .. })
        ));
        assert!(
            !outcome
                .commands
                .iter()
                .any(|command| command["type"] == "acquireControl")
        );
        search_key(&mut app, KeyCode::Down);
        let selected = search_target(&app).unwrap();
        search_key(&mut app, KeyCode::Enter);
        assert_eq!(app.active_id(), selected.session_id());
    }

    #[test]
    fn search_rename_that_stops_matching_does_not_open_the_duplicate() {
        let mut app = stable_search_app("工程", crate::palette::Target::Session("b".into()));
        let mut snapshot = stable_search_snapshot();
        snapshot["sessions"][1]["name"] = json!("Renamed away");
        app.event(snapshot).unwrap();
        assert_eq!(search_target(&app), None);
        assert!(
            app.palette_results("工程")
                .iter()
                .any(|row| row.target.session_id() == Some("c"))
        );
        search_key(&mut app, KeyCode::Enter);
        assert_eq!(app.active_id(), Some("anchor"));
        assert!(matches!(
            app.dialog,
            Some(Dialog::QuickSwitch { selected: None, .. })
        ));
    }

    #[test]
    fn search_filter_removal_requires_new_query_or_navigation_before_enter() {
        let mut app = stable_search_app("", crate::palette::Target::Session("b".into()));
        app.status_filters.insert(usize::MAX);
        search_key(&mut app, KeyCode::F(2));
        assert_eq!(search_target(&app), None);
        app.status_filters.clear();
        search_key(&mut app, KeyCode::F(2));
        search_key(&mut app, KeyCode::Enter);
        assert_eq!(app.active_id(), Some("anchor"));
        assert_eq!(search_target(&app), None);
        event(
            &mut app,
            Event::Paste("工程".into()),
            Rect::new(0, 0, 150, 44),
        );
        assert!(search_target(&app).is_some());
        assert!(matches!(&app.dialog, Some(Dialog::QuickSwitch { query, .. }) if query == "工程"));
        let selected = search_target(&app).unwrap();
        search_key(&mut app, KeyCode::Enter);
        assert_eq!(app.active_id(), selected.session_id());
    }

    #[test]
    fn search_provider_hint_output_cannot_replace_the_selected_session() {
        let mut app = stable_search_app("", crate::palette::Target::Session("b".into()));
        let mut snapshot = stable_search_snapshot();
        snapshot["sessions"][1]["program"] = json!("shell");
        app.event(snapshot).unwrap();
        app.event(json!({"type":"subscribed","sessionId":"b","cols":80,"rows":24}))
            .unwrap();
        app.event(json!({"type":"output","sessionId":"b","data":"Claude Code v2.1.305\r\n"}))
            .unwrap();
        app.dialog = Some(Dialog::QuickSwitch {
            query: "claude".into(),
            selected: Some(crate::palette::Target::Session("b".into())),
        });
        app.event(
            json!({"type":"output","sessionId":"b","data":"\u{1b}[2J\u{1b}[HPS C:\\work>\r\n"}),
        )
        .unwrap();
        assert_eq!(search_target(&app), None);
        assert!(!app.palette_results("claude").is_empty());
        let outcome = search_key(&mut app, KeyCode::Enter);
        assert_eq!(app.active_id(), Some("anchor"));
        assert!(
            !outcome
                .commands
                .iter()
                .any(|command| command["type"] == "acquireControl")
        );
    }

    #[test]
    fn search_expansion_preserves_unicode_duplicate_identity_and_preview_does_not_change_mru() {
        let target = crate::palette::Target::Session("c".into());
        let mut app = stable_search_app("工程", target.clone());
        app.palette_expanded = false;
        let focused = app.focused;
        let history = app.recent_sessions.clone();
        let outcome = search_key(&mut app, KeyCode::F(2));
        assert!(app.palette_expanded);
        assert_eq!(search_target(&app), Some(target));
        assert!(matches!(&app.dialog, Some(Dialog::QuickSwitch { query, .. }) if query == "工程"));
        assert_eq!(app.focused, focused);
        assert_eq!(app.active_id(), Some("anchor"));
        assert_eq!(app.recent_sessions, history);
        assert!(!outcome.commands.iter().any(|command| matches!(
            command["type"].as_str(),
            Some("acquireControl" | "releaseControl")
        )));
    }

    #[test]
    fn search_group_and_command_identities_are_not_replaced_by_matching_sessions() {
        let mut app = stable_search_app("工程", crate::palette::Target::Group("g".into()));
        app.event(stable_search_snapshot()).unwrap();
        search_key(&mut app, KeyCode::Enter);
        assert_eq!(app.active_id(), Some("anchor"));
        assert!(
            matches!(app.selected_row().map(|row| row.kind), Some(RowKind::Group(id)) if id == "g")
        );
        app.dialog = Some(Dialog::QuickSwitch {
            query: "new".into(),
            selected: Some(crate::palette::Target::Command('g')),
        });
        let mut snapshot = stable_search_snapshot();
        snapshot["sessions"][1]["name"] = json!("New session");
        app.event(snapshot).unwrap();
        search_key(&mut app, KeyCode::Enter);
        assert!(matches!(app.dialog, Some(Dialog::NewGroup { .. })));
        assert_eq!(app.active_id(), Some("anchor"));
        assert!(app.recent_sessions.is_empty());
    }

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
    fn menu_click_leaves_input_without_changing_session() {
        let mut app = App::new(1);
        app.dialog = None;
        app.mode = Mode::Input;
        app.review.focused = true;
        let area = Rect::new(0, 0, 100, 32);
        let tree = ui::geometry(area, &app).tree;
        event(
            &mut app,
            Event::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: tree.x,
                row: tree.bottom() - 1,
                modifiers: KeyModifiers::NONE,
            }),
            area,
        );
        assert!(app.mode == Mode::Navigate);
        assert!(!app.review.focused);
    }

    #[test]
    fn palette_category_buttons_preserve_query_and_reset_selection() {
        let mut app = App::new(1);
        app.palette_expanded = true;
        app.dialog = Some(Dialog::QuickSwitch {
            query: "test".into(),
            selected: Some(crate::palette::Target::Session("old-target".into())),
        });
        click(
            &mut app,
            Rect::new(0, 0, 80, 24),
            Action::PaletteCategory(2),
        );
        assert_eq!(app.palette_category, 2);
        assert!(
            matches!(&app.dialog, Some(Dialog::QuickSwitch { query, selected: None }) if query == "test")
        );
    }

    #[test]
    fn keyboard_help_sections_change_without_losing_close_button() {
        let mut app = App::new(1);
        app.dialog = Some(Dialog::Help);
        let area = Rect::new(0, 0, 80, 24);
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE)),
            area,
        );
        assert_eq!(app.help_page, 1);
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)),
            area,
        );
        assert_eq!(app.dialog_button, Some(0));
    }

    #[test]
    fn sidebar_search_clears_on_escape_and_slash_opens_expanded_palette() {
        let mut app = App::new(1);
        app.dialog = None;
        app.mode = Mode::Navigate;
        app.selected = 1;
        let area = Rect::new(0, 0, 100, 32);
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE)),
            area,
        );
        assert!(!app.palette_expanded);
        event(&mut app, Event::Paste("żółć".into()), area);
        assert!(matches!(&app.dialog, Some(Dialog::QuickSwitch { query, .. }) if query == "żółć"));
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            area,
        );
        assert!(app.dialog.is_none());
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE)),
            area,
        );
        assert!(app.palette_expanded);
        assert!(matches!(&app.dialog, Some(Dialog::QuickSwitch { query, .. }) if query.is_empty()));
    }

    #[test]
    fn fourth_menu_entry_opens_keyboard_reference_and_returns_to_menu() {
        let mut app = App::new(1);
        app.dialog = Some(Dialog::Menu);
        let area = Rect::new(0, 0, 80, 24);
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE)),
            area,
        );
        assert_eq!(app.menu_selected, 3);
        click(&mut app, area, Action::MenuChoice(3));
        assert!(matches!(app.dialog, Some(Dialog::Help)));
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            area,
        );
        assert!(matches!(app.dialog, Some(Dialog::Menu)));
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
        assert_eq!(app.active_id(), Some("one"));
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE)),
            area,
        );
        assert_eq!(app.active_id(), Some("one"));
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
                .any(|command| command["type"] == "acquireControl")
        );
    }

    #[test]
    fn control_k_belongs_to_pty_in_input_and_opens_palette_in_navigation() {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"one","name":"Docs","cwd":"/docs","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":1}
        ]})).unwrap();
        app.leases.insert("one".into(), "lease".into());
        app.terminals
            .insert("one".into(), crate::terminal::TerminalState::new(24, 80));
        app.mode = Mode::Input;
        let area = Rect::new(0, 0, 120, 30);
        let key = Event::Key(KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL));
        let result = event(&mut app, key.clone(), area);
        assert!(app.dialog.is_none());
        assert!(app.mode == Mode::Input);
        assert!(
            result
                .commands
                .iter()
                .any(|command| command["type"] == "input" && command["data"] == "\u{0b}")
        );
        app.mode = Mode::Navigate;
        event(&mut app, key, area);
        assert!(matches!(app.dialog, Some(Dialog::QuickSwitch { .. })));
        assert!(app.palette_expanded);
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
    fn folder_picker_searches_and_enter_chooses_highlighted_result() {
        let mut app = App::new(1);
        let area = Rect::new(0, 0, 100, 32);
        app.dialog = Some(Dialog::FolderPicker {
            form: SessionForm::default(),
            path: "C:/dev".into(),
            parent: Some("C:/".into()),
            entries: vec![
                crate::launch::DirectoryEntry {
                    name: "alpha".into(),
                    path: "C:/dev/alpha".into(),
                },
                crate::launch::DirectoryEntry {
                    name: "Project Beta".into(),
                    path: "C:/dev/Project Beta".into(),
                },
            ],
            query: String::new(),
            selected: 0,
            loading: false,
        });
        event(&mut app, Event::Paste("BETA".into()), area);
        assert!(
            matches!(&app.dialog, Some(Dialog::FolderPicker { query, selected: 0, .. }) if query == "BETA")
        );
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            area,
        );
        assert!(
            matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.cwd == "C:/dev/Project Beta")
        );
    }

    #[test]
    fn folder_picker_arrows_browse_and_f2_chooses_current_path() {
        let mut app = App::new(1);
        let area = Rect::new(0, 0, 100, 32);
        app.dialog = Some(Dialog::FolderPicker {
            form: SessionForm::default(),
            path: "C:/dev".into(),
            parent: Some("C:/".into()),
            entries: vec![crate::launch::DirectoryEntry {
                name: "project".into(),
                path: "C:/dev/project".into(),
            }],
            query: String::new(),
            selected: 1,
            loading: false,
        });
        let enter_child = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE)),
            area,
        );
        assert_eq!(enter_child.commands[0]["path"], "C:/dev/project");
        app.event(json!({"type":"directories","requestId":enter_child.commands[0]["requestId"],"path":"C:/dev/project","parent":"C:/dev","entries":[]})).unwrap();
        let parent = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE)),
            area,
        );
        assert_eq!(parent.commands[0]["path"], "C:/dev");
        app.event(json!({"type":"directories","requestId":parent.commands[0]["requestId"],"path":"C:/dev","parent":"C:/","entries":[]})).unwrap();
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::F(2), KeyModifiers::NONE)),
            area,
        );
        assert!(matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.cwd == "C:/dev"));
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
        assert_eq!(app.panes[..2], [Some("existing".into()), None]);

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
        assert_eq!(
            app.panes[..2],
            [Some("existing".into()), Some("new".into())]
        );
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
            switch
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
    fn z_toggles_fullscreen_and_sidebar_click_requests_input_without_takeover() {
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
            row_click
                .commands
                .iter()
                .any(|c| c["type"] == "acquireControl" && c["takeOver"] == false)
        );
        assert!(
            !row_click
                .commands
                .iter()
                .any(|command| command["type"] == "input")
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
                query: String::new(),
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

    #[cfg(windows)]
    #[test]
    fn native_altgr_query_press_release_pairs_keep_the_unicode_target_without_duplicate_text() {
        let mut app = App::new(1);
        app.event(repository_search_snapshot()).unwrap();
        app.begin_palette(String::new());
        let original_active = app.active_id().map(str::to_owned);
        let area = Rect::new(0, 0, 150, 44);
        for character in "feature/zażółć".chars() {
            let modifiers = if character.is_ascii() {
                KeyModifiers::NONE
            } else {
                KeyModifiers::CONTROL | KeyModifiers::ALT
            };
            for kind in [KeyEventKind::Press, KeyEventKind::Release] {
                let outcome = event(
                    &mut app,
                    Event::Key(KeyEvent::new_with_kind(
                        KeyCode::Char(character),
                        modifiers,
                        kind,
                    )),
                    area,
                );
                assert!(outcome.commands.iter().all(|command| matches!(
                    command["type"].as_str(),
                    Some("subscribe" | "unsubscribe")
                )));
                assert_eq!(app.active_id(), original_active.as_deref());
            }
        }
        assert!(
            matches!(&app.dialog, Some(Dialog::QuickSwitch { query, .. }) if query == "feature/zażółć")
        );
        assert_eq!(
            search_target(&app),
            Some(crate::palette::Target::Session("b".into()))
        );
        search_key(&mut app, KeyCode::F(2));
        assert!(
            matches!(&app.dialog, Some(Dialog::QuickSwitch { query, .. }) if query == "feature/zażółć")
        );
        assert!(matches!(app.mode, Mode::Navigate));
    }

    #[cfg(windows)]
    #[test]
    fn native_altgr_reaches_the_owned_pty_once_and_control_q_still_leaves_input() {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","revision":0,"groups":[],"sessions":[
            {"id":"s","name":"shell","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        app.event(json!({"type":"subscribed","sessionId":"s","cols":80,"rows":24}))
            .unwrap();
        app.activate_session("s");
        app.event(json!({"type":"control","sessionId":"s","controllerId":1,"cols":80,"rows":24,"leaseId":"altgr-owned"})).unwrap();
        let area = Rect::new(0, 0, 100, 32);
        assert!(matches!(app.mode, Mode::Input));
        let text = event(
            &mut app,
            Event::Key(KeyEvent::new(
                KeyCode::Char('ż'),
                KeyModifiers::CONTROL | KeyModifiers::ALT,
            )),
            area,
        );
        assert_eq!(
            text.commands,
            [json!({"type":"input","sessionId":"s","leaseId":"altgr-owned","data":"ż"})]
        );
        let release = event(
            &mut app,
            Event::Key(KeyEvent::new_with_kind(
                KeyCode::Char('ż'),
                KeyModifiers::CONTROL | KeyModifiers::ALT,
                KeyEventKind::Release,
            )),
            area,
        );
        assert!(release.commands.is_empty());
        let leave = event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Char('q'), KeyModifiers::CONTROL)),
            area,
        );
        assert!(leave.commands.is_empty());
        assert!(matches!(app.mode, Mode::Navigate));
    }

    #[test]
    fn escape_reaches_the_shell_then_control_q_returns_to_navigation() {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","revision":0,"groups":[],"sessions":[
            {"id":"s","name":"shell","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        app.event(json!({"type":"subscribed","sessionId":"s","cols":80,"rows":24}))
            .unwrap();
        app.activate_session("s");
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
        assert!(matches!(
            app.overlay,
            Some(crate::toolbox::Overlay::Themes(..))
        ));
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)),
            area,
        );
        assert_eq!(app.theme, Theme::Graphite);
        event(
            &mut app,
            Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            area,
        );
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
        app.activate_session("s");
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
    #[test]
    fn delayed_control_cannot_steal_focus_after_menu_or_review_opens() {
        for key in [KeyCode::F(1), KeyCode::F(4), KeyCode::Esc] {
            let mut app = App::new(1);
            app.event(json!({"type":"sessions","revision":0,"groups":[],"sessions":[{"id":"s","name":"shell","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}]})).unwrap();
            app.activate_session("s");
            assert_eq!(app.pending_input.as_deref(), Some("s"));
            event(
                &mut app,
                Event::Key(KeyEvent::new(key, KeyModifiers::NONE)),
                Rect::new(0, 0, 100, 32),
            );
            app.event(json!({"type":"control","sessionId":"s","controllerId":1,"cols":80,"rows":24,"leaseId":"delayed"})).unwrap();
            assert!(app.mode == Mode::Navigate);
            assert!(app.pending_input.is_none());
            assert!(app.owns("s"));
        }
    }

    fn session_kind_app() -> App {
        let mut app = App::new(4);
        app.event(json!({"type":"capabilities","workspace":"/work","advancedLaunch":true,"gitDiff":true,
            "programs":[{"id":"shell","available":true},{"id":"claude","available":true},
                {"id":"codex","available":true},{"id":"gemini","available":false}],
            "sessionModelProfiles":true,"launchProfileSupport":[
                {"program":"claude","supported":true,"effortValues":["low","medium","high"],"effortSource":"cli"}
            ]}))
        .unwrap();
        app.event(json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"s1","name":"Terminal 1","cwd":"/work","program":"shell","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]}))
        .unwrap();
        app.dialog = None;
        app.onboarded = true;
        app
    }

    fn press(app: &mut App, code: KeyCode) -> Outcome {
        event(
            app,
            Event::Key(KeyEvent::new(code, KeyModifiers::NONE)),
            Rect::new(0, 0, 100, 32),
        )
    }

    #[test]
    fn session_kind_menu_opens_from_key_and_palette_and_routes_each_row() {
        let mut app = session_kind_app();
        press(&mut app, KeyCode::Char('N'));
        assert_eq!(app.session_kind, Some(Picker::Kind { selected: 0 }));
        press(&mut app, KeyCode::Esc);
        assert!(app.session_kind.is_none() && app.dialog.is_none());
        press(&mut app, KeyCode::Char('N'));
        press(&mut app, KeyCode::Char('2'));
        assert!(app.session_kind.is_none());
        assert!(matches!(&app.dialog, Some(Dialog::NewSession(form))
            if form.kind == Some(SessionKind::Terminal) && form.name == "Terminal 2"
                && form.program == crate::launch::Program::Shell));
        press(&mut app, KeyCode::F(2));
        assert!(matches!(&app.dialog, Some(Dialog::NewSession(form)) if !form.advanced));
        press(&mut app, KeyCode::Down);
        press(&mut app, KeyCode::Down);
        assert_eq!(app.dialog_button, Some(0));
        press(&mut app, KeyCode::Up);
        assert!(
            matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.field == Field::Directory)
        );
        press(&mut app, KeyCode::Esc);
        press(&mut app, KeyCode::Char('N'));
        press(&mut app, KeyCode::Char('j'));
        press(&mut app, KeyCode::Char('k'));
        press(&mut app, KeyCode::Enter);
        assert!(matches!(&app.dialog, Some(Dialog::NewSession(form))
            if form.kind == Some(SessionKind::Agent) && form.program == crate::launch::Program::Claude));
        press(&mut app, KeyCode::Esc);
        press(&mut app, KeyCode::Char('n'));
        assert!(matches!(&app.dialog, Some(Dialog::NewSession(form))
            if form.kind.is_none() && form.program == crate::launch::Program::Shell));
        press(&mut app, KeyCode::Esc);
        app.palette_expanded = true;
        app.begin_palette("session kind".into());
        app.select_palette(
            app.palette_results("session kind")
                .iter()
                .position(|row| row.target == crate::palette::Target::Command('N'))
                .unwrap(),
        );
        press(&mut app, KeyCode::Enter);
        assert!(app.dialog.is_none());
        assert_eq!(app.session_kind, Some(Picker::Kind { selected: 0 }));
        press(&mut app, KeyCode::Char('3'));
        let review = press(&mut app, KeyCode::Char('1'));
        assert!(app.session_kind.is_none());
        assert_eq!(app.active_id(), Some("s1"));
        assert!(
            review
                .commands
                .iter()
                .any(|command| command["type"] == "getDiff" && command["sessionId"] == "s1")
        );
        assert!(app.review.visible && app.review.focused);
        press(&mut app, KeyCode::Esc);
        app.review.visible = false;
        app.review.focused = false;
        press(&mut app, KeyCode::Char('N'));
        press(&mut app, KeyCode::Char('3'));
        press(&mut app, KeyCode::Down);
        event(
            &mut app,
            Event::Paste("https://github.com/dkveil/nesvo/pull/12/files".into()),
            Rect::new(0, 0, 100, 32),
        );
        let pull = press(&mut app, KeyCode::Enter);
        assert!(app.session_kind.is_none());
        assert!(pull.commands.is_empty());
        assert!(app.reviews.tabs.is_empty());
        assert!(app.notice.contains("Update nesvo-host"), "{}", app.notice);
    }

    #[test]
    fn session_kind_agent_form_keys_reach_profile_fields_and_submit_launch() {
        let mut app = session_kind_app();
        press(&mut app, KeyCode::Char('N'));
        press(&mut app, KeyCode::Char('1'));
        for _ in 0..2 {
            press(&mut app, KeyCode::Tab);
        }
        assert!(
            matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.field == Field::Program)
        );
        press(&mut app, KeyCode::Tab);
        assert!(
            matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.field == Field::Model)
        );
        for c in "sonnet".chars() {
            press(&mut app, KeyCode::Char(c));
        }
        press(&mut app, KeyCode::Enter);
        press(&mut app, KeyCode::Right);
        press(&mut app, KeyCode::Right);
        assert!(matches!(&app.dialog, Some(Dialog::NewSession(form))
            if form.field == Field::Effort && form.model == "sonnet" && form.effort == "medium"));
        press(&mut app, KeyCode::Down);
        assert_eq!(app.dialog_button, Some(0));
        press(&mut app, KeyCode::Up);
        assert!(
            matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.field == Field::Effort)
        );
        let created = press(&mut app, KeyCode::Enter);
        assert_eq!(created.commands[0]["type"], "launch");
        assert_eq!(created.commands[0]["spec"]["model"], "sonnet");
        assert_eq!(created.commands[0]["spec"]["effort"], "medium");
        press(&mut app, KeyCode::Char('N'));
        press(&mut app, KeyCode::Char('1'));
        if let Some(Dialog::NewSession(form)) = &mut app.dialog {
            form.field = Field::Program;
        }
        press(&mut app, KeyCode::Up);
        assert!(
            matches!(&app.dialog, Some(Dialog::NewSession(form)) if form.field == Field::Directory)
        );
        press(&mut app, KeyCode::Down);
        press(&mut app, KeyCode::Down);
        press(&mut app, KeyCode::Down);
        assert!(matches!(&app.dialog, Some(Dialog::NewSession(form))
            if form.program == crate::launch::Program::Codex && form.field == Field::Program));
        press(&mut app, KeyCode::Down);
        assert_eq!(app.dialog_button, Some(0));
        let area = Rect::new(0, 0, 100, 32);
        click(
            &mut app,
            area,
            Action::Program(crate::launch::Program::Shell),
        );
        assert!(matches!(&app.dialog, Some(Dialog::NewSession(form))
            if form.program == crate::launch::Program::Codex));
    }

    #[test]
    fn layouts_key_and_palette_open_the_dialog_and_tab_skips_view_panes() {
        let mut app = session_kind_app();
        app.event(json!({"type":"sessions","revision":2,"groups":[],"sessions":[
            {"id":"s1","name":"Terminal 1","cwd":"/work","program":"shell","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null},
            {"id":"a1","name":"Agent","cwd":"/work","program":"claude","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]}))
        .unwrap();
        press(&mut app, KeyCode::Char('L'));
        assert_eq!(app.layout_picker.as_ref().map(|p| p.selected), Some(0));
        let applied = press(&mut app, KeyCode::Enter);
        assert!(app.layout_picker.is_none());
        assert!(
            applied
                .commands
                .iter()
                .all(|c| c["type"] != "acquireControl")
        );
        assert_eq!(app.panes[..2], [Some("a1".into()), Some("s1".into())]);
        assert_eq!(app.focused, 0);
        press(&mut app, KeyCode::Tab);
        assert_eq!(app.focused, 1);
        press(&mut app, KeyCode::BackTab);
        assert_eq!(app.focused, 0);

        press(&mut app, KeyCode::Char('/'));
        event(
            &mut app,
            Event::Paste("Layouts".into()),
            Rect::new(0, 0, 100, 32),
        );
        press(&mut app, KeyCode::Enter);
        assert!(app.layout_picker.is_some());
        press(&mut app, KeyCode::Down);
        press(&mut app, KeyCode::Down);
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.leaf_count(), 2);
        assert_eq!(app.pane_tree().slots()[1].role, crate::layouts::Role::Files);
        press(&mut app, KeyCode::Tab);
        assert_eq!(app.focused, 0);
        assert_eq!(app.active_id(), Some("a1"));

        press(&mut app, KeyCode::Char('v'));
        assert!(!app.split && app.pane_layout.is_none());
        assert_eq!(app.leaf_count(), 1);
        assert_eq!(app.active_id(), Some("a1"));
        press(&mut app, KeyCode::Char('v'));
        assert_eq!(app.pane_tree(), crate::layouts::PaneTree::classic());
    }
}

#[cfg(test)]
mod review_tests {
    use super::*;

    const WIDE: Rect = Rect::new(0, 0, 150, 44);
    const PATCH: &str = "diff --git a/src/a.rs b/src/a.rs\n@@ -1,4 +1,4 @@\n fn main() {\n-    old();\n+    new();\n     keep();\n }";

    fn review_app() -> App {
        let mut app = App::new(7);
        app.event(
            json!({"type":"capabilities","workspace":"/work","gitDiff":true,"reviews":true,
            "programs":[{"id":"shell","available":true},{"id":"claude","available":true}]}),
        )
        .unwrap();
        app.event(json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"s1","name":"Agent","cwd":"/work","program":"claude","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null},
            {"id":"s2","name":"Shell","cwd":"/work","program":"shell","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]}))
        .unwrap();
        app.dialog = None;
        app.onboarded = true;
        app
    }

    fn key(app: &mut App, code: KeyCode, area: Rect) -> Outcome {
        event(
            app,
            Event::Key(KeyEvent::new(code, KeyModifiers::NONE)),
            area,
        )
    }

    fn typed(app: &mut App, text: &str) {
        for c in text.chars() {
            key(app, KeyCode::Char(c), WIDE);
        }
    }

    fn command<'a>(outcome: &'a Outcome, kind: &str) -> &'a Value {
        outcome
            .commands
            .iter()
            .find(|command| command["type"] == kind)
            .unwrap_or_else(|| panic!("no {kind} in {:?}", outcome.commands))
    }

    fn bind(app: &mut App, request: &Value, id: &str) -> Vec<Value> {
        app.event(json!({"type":"reviewOpened","requestId":request["requestId"],"reviewId":id,
            "directory":"/work","source":{"kind":"local","sessionId":"s1","context":"Automatic"},
            "base":{"ref":"main","oid":"1111111111111111","mergeBase":"2222222"},
            "head":{"ref":"feature","oid":"3333333333333333"},"scope":"branch","revision":"r1","checks":null}))
        .unwrap()
    }

    fn diff(app: &mut App, request: &Value, revision: &str, patch: &str) -> Vec<Value> {
        app.event(json!({"type":"diff","sessionId":null,"reviewId":request["reviewId"],"requestId":request["requestId"],
            "review":{"directory":"/work","scope":"branch","revision":revision,"head":"3333333","files":[
                {"path":"src/a.rs","status":"M","patch":patch,"additions":1,"deletions":1,"truncated":false}
            ],"truncated":false}}))
        .unwrap()
    }

    fn opened_review(app: &mut App) {
        let open = key(app, KeyCode::F(4), WIDE);
        let request = command(&open, "openReview").clone();
        let commands = bind(app, &request, "local-abc");
        let get = commands[0].clone();
        let context = diff(app, &get, "r1", PATCH);
        app.event(json!({"type":"reviewContext","requestId":context[0]["requestId"],"reviewId":"local-abc",
            "directory":"/work","readiness":{"blockers":["dirty"],"ready":false,"branch":"feature"},
            "provenance":{"evidence":"hooks","files":[{"path":"src/a.rs","attribution":"agent","thisTurn":true}],"truncated":false},
            "checks":null}))
        .unwrap();
    }

    #[test]
    fn review_tab_opens_from_f4_menu_and_broadcast_while_narrow_f4_keeps_the_dock() {
        let mut app = review_app();
        app.activate_session("s1");
        app.mode = Mode::Navigate;
        let narrow = key(&mut app, KeyCode::F(4), Rect::new(0, 0, 100, 32));
        let dock = command(&narrow, "getDiff").clone();
        assert_eq!(dock["sessionId"], "s1");
        assert!(app.review.visible && app.reviews.tabs.is_empty());
        key(&mut app, KeyCode::F(4), Rect::new(0, 0, 100, 32));
        assert!(!app.review.visible);

        let open = key(&mut app, KeyCode::F(4), WIDE);
        assert!(
            open.commands.is_empty(),
            "queued behind the dock's Git request"
        );
        let sent = app
            .event(
                json!({"type":"diff","sessionId":"s1","requestId":dock["requestId"],
                "review":{"directory":"/work","files":[],"truncated":false}}),
            )
            .unwrap();
        let request = sent[0].clone();
        assert_eq!(request["type"], "openReview");
        assert_eq!(request["source"], json!({"kind":"local","sessionId":"s1"}));
        assert_eq!(app.reviews.shown, Some(0));
        assert!(app.reviews.has_focus() && app.reviews.tabs[0].is_opening());
        app.event(
            json!({"type":"reviewProgress","requestId":request["requestId"],"stage":"metadata"}),
        )
        .unwrap();
        assert_eq!(app.reviews.tabs[0].stage.as_deref(), Some("metadata"));
        let commands = bind(&mut app, &request, "local-abc");
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0]["type"], "getDiff");
        assert_eq!(commands[0]["reviewId"], "local-abc");
        assert_eq!(commands[0]["scope"], "branch");
        assert!(commands[0].get("sessionId").is_none() && commands[0].get("base").is_none());
        let context = diff(&mut app, &commands[0], "r1", PATCH);
        assert_eq!(context[0]["type"], "reviewContext");

        key(&mut app, KeyCode::F(4), WIDE);
        assert!(app.reviews.shown.is_none() && app.reviews.tabs.len() == 1);
        key(&mut app, KeyCode::F(4), WIDE);
        assert_eq!(app.reviews.shown, Some(0));
        assert_eq!(app.reviews.tabs.len(), 1);

        let refreshed = app
            .event(json!({"type":"reviewContext","requestId":context[0]["requestId"],"reviewId":"local-abc",
                "directory":"/work","readiness":{"blockers":[],"ready":true},"provenance":null,"checks":null}))
            .unwrap();
        assert_eq!(refreshed[0]["type"], "getDiff");
        assert!(diff(&mut app, &refreshed[0], "r1", PATCH).is_empty());
        key(&mut app, KeyCode::Esc, WIDE);
        assert!(!app.reviews.focused && app.reviews.shown == Some(0));
        key(&mut app, KeyCode::Char('N'), WIDE);
        key(&mut app, KeyCode::Char('3'), WIDE);
        key(&mut app, KeyCode::Down, WIDE);
        event(
            &mut app,
            Event::Paste("https://github.com/dkveil/nesvo/pull/12".into()),
            WIDE,
        );
        let pull = key(&mut app, KeyCode::Enter, WIDE);
        assert_eq!(
            command(&pull, "openReview")["source"],
            json!({"kind":"pull","url":"https://github.com/dkveil/nesvo/pull/12"})
        );
        assert_eq!(app.reviews.tabs[1].label, "dkveil/nesvo#12");
        assert_eq!(app.reviews.shown, Some(1));

        app.event(json!({"type":"reviewOpened","reviewId":"pull-o-r-5","directory":"/cfg/o-r-5",
            "source":{"kind":"pull","url":"https://github.com/o/r/pull/5","owner":"o","repo":"r","number":5,
                "title":"Fix","state":"OPEN","headRef":"f","baseRef":"main","headOid":"abc"},
            "base":null,"head":{"ref":"f","oid":"abc"},"scope":"unstaged","revision":"x",
            "checks":{"headOid":"abc","total":2,"passed":1,"failed":1,"pending":0}}))
            .unwrap();
        assert_eq!(app.reviews.tabs.len(), 3);
        assert_eq!(app.reviews.shown, Some(1));
        assert!(app.notice.contains("o/r#5"), "{}", app.notice);
        assert!(ui::tab_title(&app, app.tabs.len() + 2).starts_with("◆ o/r#5"));
    }

    #[test]
    fn review_tab_keys_comment_edit_delete_send_and_close() {
        let mut app = review_app();
        app.activate_session("s1");
        app.mode = Mode::Navigate;
        opened_review(&mut app);
        let tab = &app.reviews.tabs[0];
        assert_eq!(tab.view.cursor, 2);
        key(&mut app, KeyCode::Tab, WIDE);
        key(&mut app, KeyCode::Char('v'), WIDE);
        key(&mut app, KeyCode::Char('j'), WIDE);
        key(&mut app, KeyCode::Char('c'), WIDE);
        typed(&mut app, "Rename");
        event(&mut app, Event::Paste(" this\r\npair".into()), WIDE);
        key(&mut app, KeyCode::Enter, WIDE);
        let tab = &app.reviews.tabs[0];
        assert_eq!(tab.comments.comments.len(), 1);
        let comment = &tab.comments.comments[0];
        assert_eq!(
            (
                comment.anchor.start,
                comment.anchor.end,
                comment.anchor.side
            ),
            (2, 2, crate::review_comments::Side::New)
        );
        assert_eq!(comment.anchor.snippet, "    new();");
        assert_eq!(comment.text, "Rename this\npair");
        assert!(tab.view.anchor.is_none());

        key(&mut app, KeyCode::Char('k'), WIDE);
        key(&mut app, KeyCode::Char('k'), WIDE);
        key(&mut app, KeyCode::Char('n'), WIDE);
        assert_eq!(app.reviews.tabs[0].view.cursor, 3);
        key(&mut app, KeyCode::Char('e'), WIDE);
        for _ in 0..4 {
            key(&mut app, KeyCode::Backspace, WIDE);
        }
        typed(&mut app, "lines");
        key(&mut app, KeyCode::Enter, WIDE);
        assert_eq!(
            app.reviews.tabs[0].comments.comments[0].text,
            "Rename this\nlines"
        );
        key(&mut app, KeyCode::Char('C'), WIDE);
        typed(&mut app, "Nearly done");
        key(&mut app, KeyCode::Enter, WIDE);
        assert_eq!(app.reviews.tabs[0].comments.summary, "Nearly done");

        let copy = key(&mut app, KeyCode::Char('y'), WIDE);
        assert!(copy.clipboard.unwrap().starts_with("Nearly done\n"));

        key(&mut app, KeyCode::Char('s'), WIDE);
        assert!(matches!(&app.dialog, Some(Dialog::QuickSwitch { query, .. }) if query == "@ "));
        assert_eq!(app.reviews.picking.as_deref(), Some("local-abc"));
        let rows = app.palette_results("@ ");
        assert!(
            rows.iter()
                .all(|row| row.target != crate::palette::Target::Session("s2".into()))
        );
        let index = rows
            .iter()
            .position(|row| row.target == crate::palette::Target::Session("s1".into()))
            .unwrap();
        app.select_palette(index);
        let send = key(&mut app, KeyCode::Enter, WIDE);
        let deliver = command(&send, "deliverReview");
        assert_eq!(deliver["reviewId"], "local-abc");
        assert_eq!(deliver["sessionId"], "s1");
        assert!(deliver.get("leaseId").is_none());
        let text = deliver["text"].as_str().unwrap();
        assert!(text.starts_with("Nearly done\n"), "{text}");
        assert!(
            text.contains("1. src/a.rs:2\n>     new();\nRename this\nlines"),
            "{text}"
        );
        assert!(app.dialog.is_none() && app.reviews.picking.is_none());
        assert!(app.reviews.has_focus());
        app.event(
            json!({"type":"reviewDelivered","requestId":deliver["requestId"],"reviewId":"local-abc",
            "sessionId":"s1","path":"operation","key":"review-1","bytes":text.len(),
            "receipt":{"id":"0123456789abcdef","phase":"accepted"}}),
        )
        .unwrap();
        let status = app.reviews.tabs[0].status.clone().unwrap();
        assert!(status.text.starts_with("Sent to Agent"), "{}", status.text);
        assert!(status.text.contains("receipt 01234567"));

        key(&mut app, KeyCode::Char('d'), WIDE);
        assert!(app.reviews.tabs[0].comments.comments.is_empty());
        key(&mut app, KeyCode::Char('q'), WIDE);
        assert!(app.reviews.tabs.is_empty() && app.reviews.shown.is_none());
        assert!(!app.reviews.focused);
    }

    #[test]
    fn review_send_with_lease_pastes_and_shows_refusals() {
        let mut app = review_app();
        app.activate_session("s1");
        app.mode = Mode::Navigate;
        opened_review(&mut app);
        app.event(json!({"type":"control","sessionId":"s1","controllerId":7,"cols":80,"rows":24,"leaseId":"lease-1"}))
            .unwrap();
        key(&mut app, KeyCode::Char('s'), WIDE);
        assert!(app.dialog.is_none());
        assert!(
            app.reviews.tabs[0]
                .status
                .as_ref()
                .unwrap()
                .text
                .contains("Nothing to send")
        );
        key(&mut app, KeyCode::Tab, WIDE);
        key(&mut app, KeyCode::Char('c'), WIDE);
        typed(&mut app, "x");
        key(&mut app, KeyCode::Enter, WIDE);
        key(&mut app, KeyCode::Char('s'), WIDE);
        let index = app
            .palette_results("@ ")
            .iter()
            .position(|row| row.target == crate::palette::Target::Session("s1".into()))
            .unwrap();
        app.select_palette(index);
        let send = key(&mut app, KeyCode::Enter, WIDE);
        let deliver = command(&send, "deliverReview").clone();
        assert_eq!(deliver["leaseId"], "lease-1");
        app.event(json!({"type":"error","requestId":deliver["requestId"],"code":"control_busy","message":"busy"}))
            .unwrap();
        let status = app.reviews.tabs[0].status.clone().unwrap();
        assert!(status.text.contains("control_busy"), "{}", status.text);
        key(&mut app, KeyCode::Char('s'), WIDE);
        key(&mut app, KeyCode::Esc, WIDE);
        assert!(app.dialog.is_none() && app.reviews.picking.is_none());
    }

    #[test]
    fn review_tab_scope_base_and_mouse_route_to_the_review() {
        let mut app = review_app();
        app.activate_session("s1");
        app.mode = Mode::Navigate;
        opened_review(&mut app);
        let uncommitted = key(&mut app, KeyCode::Char('u'), WIDE);
        let get = command(&uncommitted, "getDiff").clone();
        assert_eq!(
            (get["scope"].as_str(), get["base"].as_str()),
            (Some("branch"), Some("HEAD"))
        );
        let context = diff(&mut app, &get, "r2", PATCH);
        assert_eq!(context[0]["type"], "reviewContext");
        key(&mut app, KeyCode::Char('B'), WIDE);
        typed(&mut app, "release");
        let base = key(&mut app, KeyCode::Enter, WIDE);
        assert!(base.commands.is_empty(), "{:?}", base.commands);
        let ready = app
            .event(json!({"type":"reviewContext","requestId":context[0]["requestId"],"reviewId":"local-abc",
                "directory":"/work","readiness":{"blockers":[],"ready":true},"provenance":null,"checks":null}))
            .unwrap();
        assert_eq!(ready[0]["type"], "getDiff");
        assert_eq!(ready[0]["base"], "release");
        diff(&mut app, &ready[0], "r3", PATCH);
        let rect = ui::geometry(WIDE, &app).review;
        let tab = app.reviews.active().unwrap();
        let areas = crate::ui_review::areas(rect, tab);
        event(
            &mut app,
            Event::Mouse(crossterm::event::MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: areas.diff.x + 3,
                row: areas.diff.y + 1,
                modifiers: KeyModifiers::NONE,
            }),
            WIDE,
        );
        let tab = app.reviews.active().unwrap();
        assert_eq!(tab.view.pane, crate::review_session::Pane::Diff);
        assert_eq!(tab.view.cursor, 1);
        assert!(app.reviews.has_focus());
    }
}
