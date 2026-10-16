//! Shared, pure geometry for visible controls and mouse hit testing.
use crate::{
    brand,
    launch::{Field, Program},
    model::{App, Dialog, folder_choices},
    theme::{BACKGROUND, DANGER, FAINT, MUTED, TEXT},
    ui,
};
use ratatui::{
    Frame,
    layout::Rect,
    style::Style,
    text::Line,
    widgets::{Block, Paragraph},
};

pub const HOME_ACTION_ROWS: [u16; 3] = [2, 4, 6];

pub fn home_action_rows(content: Rect) -> [u16; 3] {
    HOME_ACTION_ROWS.map(|row| row + brand::home_offset(content))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    MenuChoice(usize),
    SettingChoice(usize),
    GroupName,
    GroupParent(usize),
    Navigation(char),
    ToggleFullscreen,
    PaneNavigation { pane: usize, key: char },
    Submit,
    Cancel,
    Field(Field),
    Program(Program),
    DirectoryChoice(usize),
    MoveChoice(usize),
    QuickChoice(usize),
    FocusSearch,
    OpenRow(usize),
    FocusTab(usize),
    FocusPane(usize),
}

pub struct Control {
    pub area: Rect,
    pub label: Option<String>,
    pub action: Action,
    pub enabled: bool,
}

pub fn dialog_body(inner: Rect) -> Rect {
    Rect::new(
        inner.x.saturating_add(2.min(inner.width)),
        inner.y.saturating_add(2.min(inner.height)),
        inner.width.saturating_sub(4),
        inner.height.saturating_sub(4),
    )
}

pub fn dialog_actions(inner: Rect) -> Rect {
    let width = inner.width.saturating_sub(4).min(26);
    Rect::new(
        inner.right().saturating_sub(width + 2),
        inner.bottom().saturating_sub(1),
        width,
        u16::from(inner.height > 0),
    )
}

pub fn move_offset(selected: usize, height: u16) -> usize {
    selected.saturating_sub(usize::from(height.saturating_sub(1)))
}

pub fn menu_area(area: Rect) -> Rect {
    let width = area.width.saturating_sub(4).min(60);
    let height = area.height.saturating_sub(2).min(20);
    Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    )
}

pub fn menu_action_area(area: Rect, index: usize) -> Rect {
    let menu = menu_area(area);
    let offset = if brand::area(menu).is_some() { 9 } else { 1 };
    let y = menu.y.saturating_add(offset + index as u16 * 3);
    if y >= menu.bottom() {
        return Rect::default();
    }
    let width = menu.width.min(34);
    Rect::new(
        menu.x + menu.width.saturating_sub(width) / 2,
        y,
        width,
        3.min(menu.bottom() - y),
    )
}

fn row(area: Rect, offset: u16) -> Rect {
    if offset >= area.height {
        return Rect::default();
    }
    Rect::new(area.x, area.y + offset, area.width, 1)
}

fn buttons(
    area: Rect,
    entries: impl IntoIterator<Item = (&'static str, Action, bool)>,
    output: &mut Vec<Control>,
) {
    if area.height == 0 {
        return;
    }
    let mut x = area.x;
    for (label, action, enabled) in entries {
        let label = format!(" {label} ");
        let width = Line::from(label.as_str()).width() as u16;
        if x.saturating_add(width) > area.right() {
            break;
        }
        output.push(Control {
            area: Rect::new(x, area.y, width, 1),
            label: Some(label),
            action,
            enabled,
        });
        x += width + 1;
    }
}

pub fn controls(app: &App, area: Rect) -> Vec<Control> {
    let mut output = Vec::new();
    let tree = ui::geometry(area, app).tree;
    if tree.width > 0
        && tree.height > 0
        && (app.dialog.is_none() || matches!(app.dialog, Some(Dialog::QuickSwitch { .. })))
    {
        let content = ui::tree_content(tree);
        output.push(Control {
            area: Rect::new(content.x, content.y, content.width, 1),
            label: None,
            action: Action::FocusSearch,
            enabled: true,
        });
        if let Some(Dialog::QuickSwitch { query, selected }) = &app.dialog {
            let count = app.quick_switch_results(query).len();
            let visible = usize::from(content.height.saturating_sub(1) / 2);
            let offset = selected.saturating_sub(visible.saturating_sub(1));
            for index in offset..count.min(offset + visible) {
                output.push(Control {
                    area: Rect::new(
                        content.x,
                        content.y + 1 + ((index - offset) as u16) * 2,
                        content.width,
                        2,
                    ),
                    label: None,
                    action: Action::QuickChoice(index),
                    enabled: true,
                });
            }
            return output;
        }
    }
    if let Some(dialog) = &app.dialog {
        if matches!(dialog, Dialog::Menu) {
            for index in 0..3 {
                output.push(Control {
                    area: menu_action_area(area, index),
                    label: None,
                    action: Action::MenuChoice(index),
                    enabled: true,
                });
            }
            return output;
        }
        let Some(dialog_area) = ui::dialog_area(area, dialog) else {
            return output;
        };
        let inner = Block::bordered().inner(dialog_area);
        let body = dialog_body(inner);
        match dialog {
            Dialog::Menu => unreachable!("Menu has its own full-screen geometry"),
            Dialog::QuickSwitch { query, selected } => {
                let count = app.quick_switch_results(query).len();
                let visible = body.height.saturating_sub(5);
                let offset = move_offset(*selected, visible);
                for index in offset..count.min(offset + usize::from(visible)) {
                    output.push(Control {
                        area: row(body, 3 + (index - offset) as u16),
                        label: None,
                        action: Action::QuickChoice(index),
                        enabled: true,
                    });
                }
                buttons(
                    dialog_actions(inner),
                    [("Close", Action::Cancel, true)],
                    &mut output,
                );
            }
            Dialog::ExitConfirm { .. } => {
                buttons(
                    dialog_actions(inner),
                    [
                        ("Leave nesvo", Action::Submit, true),
                        ("Stay", Action::Cancel, true),
                    ],
                    &mut output,
                );
            }
            Dialog::Settings { .. } => {
                for index in 0..2 {
                    output.push(Control {
                        area: row(body, 1 + index as u16 * 2),
                        label: None,
                        action: Action::SettingChoice(index),
                        enabled: true,
                    });
                }
                buttons(
                    dialog_actions(inner),
                    [("Close", Action::Cancel, true)],
                    &mut output,
                );
            }
            Dialog::NewGroup { parent_index, .. } => {
                output.push(Control {
                    area: row(body, 1),
                    label: None,
                    action: Action::GroupName,
                    enabled: true,
                });
                let choices = app.group_choices(None);
                let offset = move_offset(*parent_index, body.height.saturating_sub(4));
                for index in offset
                    ..choices
                        .len()
                        .min(offset + usize::from(body.height.saturating_sub(4)))
                {
                    output.push(Control {
                        area: row(body, 4 + (index - offset) as u16),
                        label: None,
                        action: Action::GroupParent(index),
                        enabled: true,
                    });
                }
                buttons(
                    dialog_actions(inner),
                    [
                        ("Create", Action::Submit, app.connected),
                        ("Cancel", Action::Cancel, true),
                    ],
                    &mut output,
                );
            }
            Dialog::NewSession(form) => {
                for (offset, field) in [(3, Field::Name), (6, Field::Directory)] {
                    output.push(Control {
                        area: row(body, offset),
                        label: None,
                        action: Action::Field(field),
                        enabled: true,
                    });
                }
                for (index, program) in Program::ALL.into_iter().enumerate() {
                    output.push(Control {
                        area: row(body, 10 + index as u16),
                        label: None,
                        action: Action::Program(program),
                        enabled: true,
                    });
                }
                buttons(
                    dialog_actions(inner),
                    [
                        (
                            "Create",
                            Action::Submit,
                            app.connected
                                && app
                                    .capabilities
                                    .as_ref()
                                    .is_some_and(|caps| caps.available(form.program)),
                        ),
                        ("Cancel", Action::Cancel, true),
                    ],
                    &mut output,
                );
            }
            Dialog::FolderPicker {
                parent,
                entries,
                query,
                selected,
                ..
            } => {
                let visible = body.height.saturating_sub(5);
                let count = folder_choices(parent, entries, query).len();
                let offset = move_offset(*selected, visible);
                for index in offset..count.min(offset + usize::from(visible)) {
                    output.push(Control {
                        area: row(body, 4 + (index - offset) as u16),
                        label: None,
                        action: Action::DirectoryChoice(index),
                        enabled: true,
                    });
                }
                buttons(
                    dialog_actions(inner),
                    [
                        ("Use this folder", Action::Submit, true),
                        ("Back", Action::Cancel, true),
                    ],
                    &mut output,
                );
            }
            Dialog::Move {
                choices, selected, ..
            } => {
                let offset = move_offset(*selected, body.height);
                for (position, _) in choices
                    .iter()
                    .enumerate()
                    .skip(offset)
                    .take(usize::from(body.height))
                {
                    output.push(Control {
                        area: row(body, (position - offset) as u16),
                        label: None,
                        action: Action::MoveChoice(position),
                        enabled: true,
                    });
                }
                buttons(
                    dialog_actions(inner),
                    [
                        ("Move", Action::Submit, app.connected),
                        ("Cancel", Action::Cancel, true),
                    ],
                    &mut output,
                );
            }
            Dialog::Text { .. } | Dialog::Confirm { .. } => {
                let label = match dialog {
                    Dialog::Confirm { command, .. }
                        if matches!(command["type"].as_str(), Some("close" | "deleteGroup")) =>
                    {
                        "Delete"
                    }
                    Dialog::Confirm { .. } => "Take control",
                    _ => "Save",
                };
                buttons(
                    dialog_actions(inner),
                    [
                        (label, Action::Submit, app.connected),
                        ("Cancel", Action::Cancel, true),
                    ],
                    &mut output,
                );
            }
            Dialog::Help | Dialog::PairPhone => {
                buttons(
                    dialog_actions(inner),
                    [("Close", Action::Cancel, true)],
                    &mut output,
                );
            }
        }
        return output;
    }

    let geometry = ui::geometry(area, app);
    let toggle = ui::fullscreen_handle_area(app, geometry.footer);
    if !toggle.is_empty() {
        output.push(Control {
            area: toggle,
            label: None,
            action: Action::ToggleFullscreen,
            enabled: true,
        });
    }
    if ui::immersive(app) {
        return output;
    }
    let (_, add) = ui::tab_areas(app, &geometry);
    if !add.is_empty() {
        output.push(Control {
            area: add,
            label: None,
            action: Action::Navigation('n'),
            enabled: app.connected,
        });
    }
    for index in 0..if app.split { 2 } else { 1 } {
        if app.panes[index].is_some() {
            continue;
        }
        let content = ui::pane_content(geometry.panes[index], ui::immersive(app));
        let panel = ui::home_panel(content);
        let rows = home_action_rows(content);
        for (offset, label, action, enabled) in [
            (rows[0], "n  New session", 'n', app.connected),
            (rows[1], "g  New group", 'g', app.connected),
            (rows[2], "p  Pair your phone", 'p', true),
        ] {
            buttons(
                row(panel, offset),
                [(
                    label,
                    Action::PaneNavigation {
                        pane: index,
                        key: action,
                    },
                    enabled,
                )],
                &mut output,
            );
        }
    }
    output
}

pub fn hit_test(app: &App, area: Rect, column: u16, row: u16) -> Option<Action> {
    let point = (column, row).into();
    if !area.contains(point) {
        return None;
    }
    if let Some(control) = controls(app, area)
        .into_iter()
        .find(|control| control.area.contains(point))
    {
        return control.enabled.then_some(control.action);
    }
    // A popup owns the whole interaction surface; never click through it.
    if app.dialog.is_some() {
        return None;
    }
    let geometry = ui::geometry(area, app);
    if ui::immersive(app) {
        return None;
    }
    if let Some(index) = ui::sidebar_hit(app, geometry.tree, column, row) {
        return Some(Action::OpenRow(index));
    }
    if row == geometry.header.y {
        let (tabs, _) = ui::tab_areas(app, &geometry);
        return tabs
            .iter()
            .find_map(|(index, tab)| tab.contains(point).then_some(Action::FocusTab(*index)));
    }
    (0..if app.split { 2 } else { 1 })
        .find(|index| geometry.panes[*index].contains(point))
        .map(Action::FocusPane)
}

pub fn render(frame: &mut Frame, app: &App) {
    let footer_has_submit = matches!(
        app.dialog,
        Some(
            Dialog::NewGroup { .. }
                | Dialog::NewSession(_)
                | Dialog::FolderPicker { .. }
                | Dialog::Text { .. }
                | Dialog::Move { .. }
                | Dialog::Confirm { .. }
        )
    );
    for control in controls(app, frame.area()) {
        if let Some(label) = control.label {
            let in_dialog = app.dialog.is_some() && !matches!(app.dialog, Some(Dialog::Menu));
            let selected_button = match control.action {
                Action::Submit => app.dialog_button == Some(0),
                Action::Cancel => app.dialog_button == Some(usize::from(footer_has_submit)),
                _ => false,
            };
            let primary = in_dialog
                && (selected_button
                    || (app.dialog_button.is_none() && matches!(control.action, Action::Submit)));
            let exit_choice = match (&app.dialog, control.action) {
                (Some(Dialog::ExitConfirm { leave_selected, .. }), Action::Submit) => {
                    Some(*leave_selected)
                }
                (Some(Dialog::ExitConfirm { leave_selected, .. }), Action::Cancel) => {
                    Some(!*leave_selected)
                }
                _ => None,
            };
            let destructive = matches!(
                &app.dialog,
                Some(Dialog::Confirm { command, .. })
                    if matches!(command["type"].as_str(), Some("close" | "deleteGroup"))
            );
            frame.render_widget(
                Paragraph::new(label).style(
                    Style::default()
                        .bg(if primary && control.enabled {
                            if exit_choice == Some(false) {
                                BACKGROUND
                            } else if destructive && matches!(control.action, Action::Submit) {
                                DANGER
                            } else {
                                app.theme.accent()
                            }
                        } else if exit_choice == Some(true) {
                            app.theme.accent()
                        } else {
                            BACKGROUND
                        })
                        .fg(if !control.enabled {
                            FAINT
                        } else if exit_choice == Some(true) || (primary && exit_choice.is_none()) {
                            BACKGROUND
                        } else if exit_choice == Some(false) {
                            MUTED
                        } else if in_dialog {
                            TEXT
                        } else if matches!(control.action, Action::MenuChoice(index) if index == app.menu_selected)
                            || matches!(control.action, Action::Submit | Action::Navigation('n') | Action::PaneNavigation { key: 'n', .. }) {
                            app.theme.accent()
                        } else if matches!(control.action, Action::PaneNavigation { .. }) {
                            TEXT
                        } else {
                            MUTED
                        }),
                ),
                control.area,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tabs_and_new_session_control_are_clickable() {
        let mut app = App::new(1);
        app.connected = true;
        app.event(serde_json::json!({"type":"sessions","revision":0,"groups":[],"sessions":[
            {"id":"first","name":"First","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null},
            {"id":"second","name":"Second","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        app.open_session("second");
        let area = Rect::new(0, 0, 120, 30);
        let layout = ui::geometry(area, &app);
        let (tabs, add) = ui::tab_areas(&app, &layout);
        assert_eq!(tabs.len(), 2);
        assert_eq!(
            hit_test(&app, area, tabs[0].1.x, tabs[0].1.y),
            Some(Action::FocusTab(0))
        );
        assert_eq!(
            hit_test(&app, area, tabs[1].1.x, tabs[1].1.y),
            Some(Action::FocusTab(1))
        );
        assert_eq!(
            hit_test(&app, area, add.x, add.y),
            Some(Action::Navigation('n'))
        );
    }

    #[test]
    fn blank_tree_space_does_not_open_the_last_session() {
        let app = App::new(1);
        let area = Rect::new(0, 0, 100, 32);
        let tree = ui::tree_content(ui::geometry(area, &app).tree);
        assert_eq!(
            hit_test(&app, area, tree.x, tree.y),
            Some(Action::FocusSearch)
        );
        assert_eq!(hit_test(&app, area, tree.x, tree.y + 3), None);
    }

    #[test]
    fn sidebar_search_replaces_the_root_heading_and_results_are_clickable() {
        let mut app = App::new(1);
        app.event(serde_json::json!({"type":"sessions","revision":1,"groups":[],"sessions":[
            {"id":"one","name":"Docs","cwd":"C:/dev/docs","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null},
            {"id":"two","name":"Web UI","cwd":"C:/dev/web","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        let area = Rect::new(0, 0, 100, 32);
        let tree = ui::tree_content(ui::geometry(area, &app).tree);
        assert_eq!(
            hit_test(&app, area, tree.x + 2, tree.y),
            Some(Action::FocusSearch)
        );
        app.dialog = Some(Dialog::QuickSwitch {
            query: "web".into(),
            selected: 0,
        });
        assert_eq!(
            hit_test(&app, area, tree.x + 2, tree.y + 1),
            Some(Action::QuickChoice(0))
        );
        assert_eq!(hit_test(&app, area, tree.x + 2, tree.y + 3), None);
    }

    #[test]
    fn visible_move_rows_match_scrolled_picker_without_auto_submit() {
        let mut app = App::new(1);
        app.dialog = Some(Dialog::Move {
            target: crate::model::MoveTarget::Session("s".into()),
            choices: (0..30)
                .map(|i| (Some(i.to_string()), format!("Group {i}")))
                .collect(),
            selected: 27,
        });
        let area = Rect::new(0, 0, 80, 24);
        let dialog = app.dialog.as_ref().unwrap();
        let body = dialog_body(Block::bordered().inner(ui::dialog_area(area, dialog).unwrap()));
        let offset = move_offset(27, body.height);
        assert_eq!(
            hit_test(&app, area, body.x, body.y),
            Some(Action::MoveChoice(offset))
        );
        assert_eq!(hit_test(&app, area, 0, 0), None);
    }

    #[test]
    fn compact_controls_stay_outside_the_terminal_and_match_clicks() {
        let mut app = App::new(1);
        app.panes[0] = Some("session".into());
        for area in [Rect::new(0, 0, 120, 36), Rect::new(3, 2, 80, 24)] {
            let terminal = ui::pane_content(ui::geometry(area, &app).panes[0], app.fullscreen);
            let controls = controls(&app, area);
            assert!(
                controls
                    .iter()
                    .any(|control| control.action == Action::Navigation('n'))
            );
            assert!(
                controls
                    .iter()
                    .any(|control| control.action == Action::ToggleFullscreen)
            );
            for control in controls {
                assert!(area.contains((control.area.x, control.area.y).into()));
                assert!(!terminal.intersects(control.area));
                assert_eq!(
                    hit_test(&app, area, control.area.x, control.area.y),
                    control.enabled.then_some(control.action),
                );
            }
        }
    }

    #[test]
    fn fullscreen_footer_handle_is_clickable_without_covering_session_output() {
        let mut app = App::new(1);
        app.fullscreen = true;
        app.mode = crate::model::Mode::Input;
        let area = Rect::new(0, 0, 100, 30);
        let geometry = ui::geometry(area, &app);
        assert_eq!(geometry.panes[0].height, 29);
        assert_eq!(geometry.tree.width, 0);
        let handle = ui::fullscreen_handle_area(&app, geometry.footer);
        assert!(!handle.is_empty());
        assert_eq!(
            hit_test(&app, area, handle.x, handle.y),
            Some(Action::ToggleFullscreen)
        );
        assert_eq!(hit_test(&app, area, handle.x, handle.y - 1), None);
        let narrow = Rect::new(0, 0, 38, 20);
        let narrow_footer = ui::geometry(narrow, &app).footer;
        let narrow_handle = ui::fullscreen_handle_area(&app, narrow_footer);
        assert_eq!(narrow_handle.width, 3);
        assert_eq!(
            hit_test(&app, narrow, narrow_handle.x, narrow_handle.y),
            Some(Action::ToggleFullscreen)
        );
    }

    #[test]
    fn menu_choices_use_the_visible_rows_and_shield_the_workspace() {
        let mut app = App::new(1);
        app.dialog = Some(Dialog::Menu);
        let area = Rect::new(0, 0, 120, 36);
        for (index, control) in controls(&app, area).into_iter().enumerate() {
            assert_eq!(control.action, Action::MenuChoice(index));
            assert_eq!(
                hit_test(&app, area, control.area.x, control.area.y),
                Some(control.action)
            );
        }
        assert_eq!(hit_test(&app, area, 0, 0), None);
    }
}
