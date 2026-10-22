use crate::model::{App, Dialog};
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    NoteCapture,
    WorktreeActions,
    SessionKind,
    LayoutPicker,
    Overlay,
    Dialog,
    Jobs,
    Runs,
    Projects,
    Git,
    Notes,
    Overview,
    Workspace,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Leaf {
    Git,
    Notes,
    Overview,
}

pub const STACK: [Surface; 12] = [
    Surface::NoteCapture,
    Surface::WorktreeActions,
    Surface::SessionKind,
    Surface::LayoutPicker,
    Surface::Overlay,
    Surface::Dialog,
    Surface::Jobs,
    Surface::Runs,
    Surface::Projects,
    Surface::Git,
    Surface::Notes,
    Surface::Overview,
];

impl Surface {
    pub fn is_view(self) -> bool {
        matches!(
            self,
            Self::Jobs | Self::Runs | Self::Projects | Self::Git | Self::Notes | Self::Overview
        )
    }

    pub fn is_popup(self) -> bool {
        matches!(
            self,
            Self::NoteCapture
                | Self::WorktreeActions
                | Self::SessionKind
                | Self::LayoutPicker
                | Self::Overlay
        )
    }
}

pub fn shown(app: &App, surface: Surface) -> bool {
    match surface {
        Surface::NoteCapture => app.notes.capture.is_some(),
        Surface::WorktreeActions => app.worktrees.dialog.is_some(),
        Surface::SessionKind => app.session_kind.is_some(),
        Surface::LayoutPicker => app.layout_picker.is_some(),
        Surface::Overlay => app.overlay.is_some(),
        Surface::Dialog => app.dialog.is_some(),
        Surface::Jobs => app.jobs.is_some(),
        Surface::Runs => crate::runs_controller::engaged(app),
        Surface::Projects => app.projects.open,
        Surface::Git => app.git.is_some() && crate::git_pane::leaf_index(app).is_none(),
        Surface::Notes => app.notes.open && crate::notes_controller::leaf_index(app).is_none(),
        Surface::Overview => app.overview.open,
        Surface::Workspace => true,
    }
}

fn stays_behind_dialog(app: &App, view: Surface) -> bool {
    view == Surface::Overview
        && !matches!(
            app.dialog,
            Some(
                Dialog::Menu
                    | Dialog::ExitConfirm {
                        from_menu: true,
                        ..
                    }
            )
        )
}

pub fn top(app: &App) -> Surface {
    top_of(|surface| shown(app, surface))
}

pub fn layers(app: &App) -> Vec<Surface> {
    layers_of(
        |surface| shown(app, surface),
        |view| stays_behind_dialog(app, view),
    )
}

pub fn leaf_focus(app: &App) -> Option<Leaf> {
    if top(app) != Surface::Workspace {
        None
    } else if crate::git_pane::captures(app) {
        Some(Leaf::Git)
    } else if crate::notes_controller::captures(app) {
        Some(Leaf::Notes)
    } else if crate::overview::engaged(app) {
        Some(Leaf::Overview)
    } else {
        None
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Interrupt {
    Quit,
    CancelEdit,
}

fn notes_editing(app: &App) -> bool {
    matches!(
        app.notes.view,
        crate::notes_controller::View::Edit | crate::notes_controller::View::Search
    )
}

pub fn editing_text(app: &App) -> bool {
    match top(app) {
        Surface::NoteCapture => true,
        Surface::WorktreeActions => app.worktrees.dialog.as_ref().is_some_and(|dialog| {
            matches!(dialog.page, crate::worktree_actions::Page::Confirm { .. })
        }),
        Surface::SessionKind => app
            .session_kind
            .as_ref()
            .is_some_and(crate::session_kind::Picker::typing),
        Surface::LayoutPicker => app
            .layout_picker
            .as_ref()
            .is_some_and(|picker| picker.naming.is_some()),
        Surface::Dialog => matches!(
            app.dialog,
            Some(
                Dialog::QuickSwitch { .. }
                    | Dialog::NewGroup { .. }
                    | Dialog::NewSession(_)
                    | Dialog::FolderPicker { .. }
                    | Dialog::Text { .. }
            )
        ),
        Surface::Jobs => app
            .jobs
            .as_ref()
            .is_some_and(|jobs| jobs.page == crate::jobs::Page::Form),
        Surface::Runs => app
            .runs
            .as_ref()
            .is_some_and(|runs| runs.page == crate::runs::Page::Answer),
        Surface::Notes => notes_editing(app),
        Surface::Overview => app.overview.editing,
        Surface::Workspace => match leaf_focus(app) {
            Some(Leaf::Notes) => notes_editing(app),
            Some(Leaf::Overview) => app.overview.editing,
            Some(Leaf::Git) | None => false,
        },
        Surface::Overlay | Surface::Projects | Surface::Git => false,
    }
}

pub fn interrupt(app: &App, key: &KeyEvent) -> Option<Interrupt> {
    let control_c = key.code == KeyCode::Char('\u{3}')
        || (key.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(key.code, KeyCode::Char('c' | 'C')));
    if !control_c
        || key.kind == KeyEventKind::Release
        || (top(app) == Surface::Workspace && leaf_focus(app).is_none())
    {
        return None;
    }
    Some(if editing_text(app) {
        Interrupt::CancelEdit
    } else {
        Interrupt::Quit
    })
}

fn top_of(shown: impl Fn(Surface) -> bool) -> Surface {
    STACK
        .into_iter()
        .find(|surface| shown(*surface))
        .unwrap_or(Surface::Workspace)
}

fn layers_of(
    shown: impl Fn(Surface) -> bool,
    stays_behind_dialog: impl Fn(Surface) -> bool,
) -> Vec<Surface> {
    let dialog = shown(Surface::Dialog);
    let view = STACK
        .into_iter()
        .find(|surface| surface.is_view() && shown(*surface))
        .filter(|view| !dialog || stays_behind_dialog(*view));
    let popups = STACK
        .into_iter()
        .rev()
        .filter(|surface| surface.is_popup() && shown(*surface));
    std::iter::once(Surface::Workspace)
        .chain(view)
        .chain(dialog.then_some(Surface::Dialog))
        .chain(popups)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::Event;
    use ratatui::{Terminal, backend::TestBackend, layout::Rect};

    fn is_set(mask: u32, surface: Surface) -> bool {
        surface == Surface::Workspace
            || STACK
                .iter()
                .position(|candidate| *candidate == surface)
                .is_some_and(|index| mask & (1 << index) != 0)
    }

    #[test]
    fn routing_and_drawing_agree_for_every_surface_combination() {
        for mask in 0..1u32 << STACK.len() {
            for behind in [false, true] {
                let shown = |surface| is_set(mask, surface);
                let layers = layers_of(shown, |_| behind);
                assert_eq!(
                    layers.last().copied(),
                    Some(top_of(shown)),
                    "mask {mask:#b} behind {behind}"
                );
                assert_eq!(layers.first(), Some(&Surface::Workspace));
                assert!(layers.iter().filter(|layer| layer.is_view()).count() <= 1);
                for popup in STACK.into_iter().filter(|surface| surface.is_popup()) {
                    assert_eq!(layers.contains(&popup), shown(popup), "mask {mask:#b}");
                }
                let order: Vec<_> = layers
                    .iter()
                    .skip(1)
                    .filter_map(|layer| STACK.iter().position(|surface| surface == layer))
                    .collect();
                assert!(
                    order.windows(2).all(|pair| pair[0] > pair[1]),
                    "mask {mask:#b}"
                );
            }
        }
    }

    fn connected() -> App {
        crate::notes_controller::tests::app()
    }

    fn draw(app: &App) -> String {
        let mut terminal = Terminal::new(TestBackend::new(120, 32)).unwrap();
        terminal
            .draw(|frame| crate::ui::render(frame, app, 0))
            .unwrap();
        let buffer = terminal.backend().buffer();
        (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn press(app: &mut App, code: KeyCode, modifiers: KeyModifiers) -> crate::controller::Outcome {
        crate::controller::event(
            app,
            Event::Key(KeyEvent::new(code, modifiers)),
            Rect::new(0, 0, 120, 32),
        )
    }

    fn control_c(app: &mut App) -> bool {
        press(app, KeyCode::Char('c'), KeyModifiers::CONTROL).quit
    }

    #[test]
    fn the_view_drawn_on_top_is_the_one_that_receives_keys() {
        let mut app = connected();
        app.overview.open = true;
        app.projects.open = true;
        assert_eq!(app.top_surface(), Surface::Projects);
        let screen = draw(&app);
        assert!(screen.contains(" PROJECTS "), "{screen}");
        assert!(!screen.contains(" OVERVIEW "), "{screen}");
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert!(!app.projects.open && app.overview.open);
        assert_eq!(app.top_surface(), Surface::Overview);
        assert!(draw(&app).contains(" OVERVIEW "));
        app.overlay = Some(crate::toolbox::Overlay::Filters(0));
        assert_eq!(layers(&app).last(), Some(&Surface::Overlay));
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert!(app.overlay.is_none() && app.overview.open);
    }

    #[test]
    fn control_c_quits_views_and_dialogs_but_cancels_text_edits() {
        let mut app = connected();
        app.mode = crate::model::Mode::Input;
        assert!(!control_c(&mut app));
        app.mode = crate::model::Mode::Navigate;
        press(&mut app, KeyCode::Char('L'), KeyModifiers::SHIFT);
        assert!(app.layout_picker.is_some());
        press(&mut app, KeyCode::Char('s'), KeyModifiers::NONE);
        assert!(editing_text(&app));
        assert!(!control_c(&mut app));
        assert!(
            app.layout_picker
                .as_ref()
                .is_some_and(|picker| picker.naming.is_none())
        );
        assert!(control_c(&mut app));
        app.layout_picker = None;
        app.session_kind = Some(crate::session_kind::Picker::default());
        assert!(control_c(&mut app));
        app.session_kind = None;
        app.open_palette(true);
        assert!(!control_c(&mut app));
        assert!(app.dialog.is_none());
        app.dialog = Some(Dialog::Help { from_menu: false });
        assert!(control_c(&mut app));
        app.dialog = None;
        app.notes.open = true;
        app.notes.focused = true;
        app.notes.view = crate::notes_controller::View::Search;
        app.notes.query = "plan".into();
        assert!(!control_c(&mut app));
        assert_eq!(app.notes.view, crate::notes_controller::View::Browse);
        assert!(app.notes.query.is_empty());
        assert!(control_c(&mut app));
    }

    #[test]
    fn every_palette_shortcut_starts_on_the_first_category() {
        let mut app = connected();
        for (code, modifiers) in [
            (KeyCode::Char('k'), KeyModifiers::CONTROL),
            (KeyCode::Char('\u{0b}'), KeyModifiers::NONE),
            (KeyCode::Char('/'), KeyModifiers::NONE),
        ] {
            app.dialog = None;
            app.palette_category = 2;
            press(&mut app, code, modifiers);
            assert!(matches!(app.dialog, Some(Dialog::QuickSwitch { .. })));
            assert_eq!(app.palette_category, 0, "{code:?}");
            assert!(app.palette_expanded);
        }
    }
}
