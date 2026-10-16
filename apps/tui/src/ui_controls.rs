//! Shared, pure geometry for visible controls and mouse hit testing.
use crate::{
    brand,
    launch::{Field, Program},
    model::{App, Dialog, Mode, RowKind},
    theme::{BACKGROUND, FAINT, MUTED, SURFACE, TEXT},
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
    ThemeChoice(usize),
    Navigation(char),
    ReturnToNavigation,
    ToggleFullscreen,
    PaneNavigation { pane: usize, key: char },
    Submit,
    Cancel,
    Field(Field),
    Program(Program),
    MoveChoice(usize),
    OpenRow(usize),
    FocusPane(usize),
}

pub struct Control {
    pub area: Rect,
    pub label: Option<String>,
    pub action: Action,
    pub enabled: bool,
}

pub fn dialog_body(inner: Rect) -> Rect {
    Rect {
        height: inner.height.saturating_sub(2),
        ..inner
    }
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
    let offset = if brand::area(menu).is_some() { 10 } else { 2 };
    let line = row(menu, offset + index as u16 * 2);
    let inset = line.width.saturating_sub(32) / 2;
    Rect::new(
        line.x + inset,
        line.y,
        line.width.saturating_sub(inset * 2),
        line.height,
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
    if let Some(dialog) = &app.dialog {
        if matches!(dialog, Dialog::Menu) {
            for (index, label) in [
                "Enter workspace",
                "Theme",
                "Pair mobile",
                if app.fullscreen_default {
                    "Full screen by default: on"
                } else {
                    "Full screen by default: off"
                },
            ]
            .into_iter()
            .enumerate()
            {
                buttons(
                    menu_action_area(area, index),
                    [(label, Action::MenuChoice(index), true)],
                    &mut output,
                );
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
            Dialog::Theme { .. } => {
                for index in 0..2 {
                    output.push(Control {
                        area: row(body, 1 + index as u16 * 2),
                        label: None,
                        action: Action::ThemeChoice(index),
                        enabled: true,
                    });
                }
                buttons(
                    row(inner, inner.height.saturating_sub(1)),
                    [
                        ("Apply", Action::Submit, true),
                        ("Back", Action::Cancel, true),
                    ],
                    &mut output,
                );
            }
            Dialog::NewSession(form) => {
                for (offset, field) in [(2, Field::Name), (4, Field::Directory)] {
                    output.push(Control {
                        area: row(body, offset),
                        label: None,
                        action: Action::Field(field),
                        enabled: true,
                    });
                }
                for (index, program) in Program::ALL.into_iter().enumerate() {
                    output.push(Control {
                        area: row(body, 8 + index as u16),
                        label: None,
                        action: Action::Program(program),
                        enabled: true,
                    });
                }
                buttons(
                    row(inner, inner.height.saturating_sub(1)),
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
                    row(inner, inner.height.saturating_sub(1)),
                    [
                        ("Move", Action::Submit, app.connected),
                        ("Cancel", Action::Cancel, true),
                    ],
                    &mut output,
                );
            }
            Dialog::Text { .. } | Dialog::Confirm { .. } => {
                let label = if matches!(dialog, Dialog::Confirm { .. }) {
                    "Confirm"
                } else {
                    "Save"
                };
                buttons(
                    row(inner, inner.height.saturating_sub(1)),
                    [
                        (label, Action::Submit, app.connected),
                        ("Cancel", Action::Cancel, true),
                    ],
                    &mut output,
                );
            }
            Dialog::Help | Dialog::PairPhone => {
                buttons(
                    row(inner, inner.height.saturating_sub(1)),
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
    if app.fullscreen {
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
    if app.mode == Mode::Input {
        buttons(
            row(geometry.header, 1),
            [
                ("Ctrl+Q Navigation", Action::ReturnToNavigation, true),
                ("F1 Menu", Action::Navigation('M'), true),
            ],
            &mut output,
        );
    } else {
        let can_control =
            app.connected && app.active_session().is_some_and(|session| session.running);
        let owns = app.active_id().is_some_and(|id| app.owns(id));
        let other_controls = app
            .active_session()
            .is_some_and(|session| session.controller_id.is_some() && !owns);
        let selected = app.selected_row();
        let selected_item = selected
            .as_ref()
            .is_some_and(|row| row.kind != RowKind::Root);
        let selected_group = selected
            .as_ref()
            .is_some_and(|row| matches!(row.kind, RowKind::Group(_)));
        buttons(
            row(geometry.header, 1),
            [
                ("F1 Menu", Action::Navigation('M'), true),
                (
                    if other_controls {
                        "t Take over"
                    } else {
                        "i Type"
                    },
                    Action::Navigation(if other_controls { 't' } else { 'i' }),
                    can_control,
                ),
                ("n New", Action::Navigation('n'), app.connected),
                ("g Group", Action::Navigation('g'), app.connected),
                ("p Pair", Action::Navigation('p'), true),
                (
                    if app.split { "v Single" } else { "v Split" },
                    Action::Navigation('v'),
                    true,
                ),
                ("? Help", Action::Navigation('?'), true),
                (
                    "d Delete",
                    Action::Navigation('d'),
                    app.connected && selected_item,
                ),
                ("x Release", Action::Navigation('x'), owns),
                (
                    "r Rename",
                    Action::Navigation('r'),
                    app.connected && selected_item,
                ),
                (
                    "m Move",
                    Action::Navigation('m'),
                    app.connected && selected_item,
                ),
                (
                    "G Subgroup",
                    Action::Navigation('G'),
                    app.connected && selected_group,
                ),
            ],
            &mut output,
        );
    }
    for index in 0..if app.split { 2 } else { 1 } {
        if app.panes[index].is_some() {
            continue;
        }
        let content = ui::pane_content(geometry.panes[index], app.fullscreen);
        let rows = home_action_rows(content);
        for (offset, label, action, enabled) in [
            (rows[0], "n  New session", 'n', app.connected),
            (rows[1], "g  New group", 'g', app.connected),
            (rows[2], "p  Pair your phone", 'p', true),
        ] {
            buttons(
                row(content, offset),
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
    if app.fullscreen {
        return None;
    }
    if let Some(index) = ui::sidebar_hit(app, geometry.tree, column, row) {
        return Some(Action::OpenRow(index));
    }
    if row == geometry.header.y {
        let (tabs, _) = ui::tab_areas(app, &geometry);
        return tabs
            .iter()
            .position(|tab| tab.contains(point))
            .map(Action::FocusPane);
    }
    (0..if app.split { 2 } else { 1 })
        .find(|index| geometry.panes[*index].contains(point))
        .map(Action::FocusPane)
}

pub fn render(frame: &mut Frame, app: &App) {
    for control in controls(app, frame.area()) {
        if let Some(label) = control.label {
            frame.render_widget(
                Paragraph::new(label).style(
                    Style::default()
                        .bg(if matches!(app.dialog, Some(Dialog::Menu)) || app.dialog.is_none() { BACKGROUND } else { SURFACE })
                        .fg(if !control.enabled {
                            FAINT
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
        app.split = true;
        let area = Rect::new(0, 0, 120, 30);
        let layout = ui::geometry(area, &app);
        let (tabs, add) = ui::tab_areas(&app, &layout);
        assert_eq!(
            hit_test(&app, area, tabs[0].x, tabs[0].y),
            Some(Action::FocusPane(0))
        );
        assert_eq!(
            hit_test(&app, area, tabs[1].x, tabs[1].y),
            Some(Action::FocusPane(1))
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
            hit_test(&app, area, tree.x, tree.y + 1),
            Some(Action::OpenRow(0))
        );
        assert_eq!(hit_test(&app, area, tree.x, tree.y + 3), None);
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
    fn compact_workspace_actions_stay_outside_the_terminal_and_match_clicks() {
        let mut app = App::new(1);
        app.panes[0] = Some("session".into());
        for area in [Rect::new(0, 0, 120, 36), Rect::new(3, 2, 80, 24)] {
            let terminal = ui::pane_content(ui::geometry(area, &app).panes[0], app.fullscreen);
            let controls = controls(&app, area);
            for key in ['M', 'n', 'g', 'p', 'v', '?'] {
                assert!(
                    controls
                        .iter()
                        .any(|control| control.action == Action::Navigation(key))
                );
            }
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
        assert_eq!(narrow_handle.width, 5);
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
