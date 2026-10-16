//! Shared, pure geometry for visible controls and mouse hit testing.
use crate::{
    brand,
    launch::{Field, Program},
    model::{App, Dialog, RowKind},
    theme::{ELEVATED, FAINT, TEXT},
    ui,
};
use ratatui::{
    Frame,
    layout::Rect,
    style::Style,
    widgets::{Block, Paragraph},
};

pub const HOME_ACTION_ROWS: [u16; 3] = [2, 5, 8];

pub fn home_action_rows(content: Rect) -> [u16; 3] {
    HOME_ACTION_ROWS.map(|row| row + brand::home_offset(content))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Navigation(char),
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
        let label = format!("[ {label} ]");
        let width = label.len() as u16;
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
        let Some(dialog_area) = ui::dialog_area(area, dialog) else {
            return output;
        };
        let inner = Block::bordered().inner(dialog_area);
        let body = dialog_body(inner);
        match dialog {
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

    let geometry = ui::geometry(area, app.split);
    buttons(
        row(geometry.header, 2),
        [
            ("+ Session", Action::Navigation('n'), app.connected),
            ("+ Group", Action::Navigation('g'), app.connected),
            ("Pair phone", Action::Navigation('p'), true),
            ("Split", Action::Navigation('v'), true),
            ("Help", Action::Navigation('?'), true),
        ],
        &mut output,
    );
    let can_control = app.connected && app.active_session().is_some_and(|session| session.running);
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
        row(geometry.footer, 1),
        [
            (
                if other_controls { "Take over" } else { "Type" },
                Action::Navigation(if other_controls { 't' } else { 'i' }),
                can_control,
            ),
            ("Release", Action::Navigation('x'), owns),
            (
                "Rename",
                Action::Navigation('r'),
                app.connected && selected_item,
            ),
            (
                "Move",
                Action::Navigation('m'),
                app.connected && selected_item,
            ),
            (
                if selected_group {
                    "Delete group"
                } else {
                    "Stop"
                },
                Action::Navigation('d'),
                app.connected && selected_item,
            ),
            (
                "+ Subgroup",
                Action::Navigation('G'),
                app.connected && selected_group,
            ),
        ],
        &mut output,
    );
    for index in 0..if app.split { 2 } else { 1 } {
        if app.panes[index].is_some() {
            continue;
        }
        let content = ui::pane_content(geometry.panes[index]);
        let rows = home_action_rows(content);
        for (offset, label, action, enabled) in [
            (rows[0], "+ New session", 'n', app.connected),
            (rows[1], "+ New group", 'g', app.connected),
            (rows[2], "Pair your phone", 'p', true),
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
    let geometry = ui::geometry(area, app.split);
    let tree = ui::tree_content(geometry.tree);
    if tree.contains(point) {
        let index = ui::tree_offset(app, geometry.tree.height) + usize::from(row - tree.y);
        return (index < app.tree().len()).then_some(Action::OpenRow(index));
    }
    (0..if app.split { 2 } else { 1 })
        .find(|index| geometry.panes[*index].contains(point))
        .map(Action::FocusPane)
}

pub fn render(frame: &mut Frame, app: &App) {
    for control in controls(app, frame.area()) {
        if let Some(label) = control.label {
            frame.render_widget(
                Paragraph::new(label).style(Style::default().bg(ELEVATED).fg(if control.enabled {
                    TEXT
                } else {
                    FAINT
                })),
                control.area,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_tree_space_does_not_open_the_last_session() {
        let app = App::new(1);
        let area = Rect::new(0, 0, 100, 32);
        let tree = ui::tree_content(ui::geometry(area, false).tree);
        assert_eq!(
            hit_test(&app, area, tree.x, tree.y),
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
}
