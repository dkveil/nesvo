//! Platform terminal lifecycle and application effects. Rendering stays pure.
use crate::{
    brand, controller,
    model::{App, Dialog},
    network::{Connection, NetworkEvent},
    output::FrameWriter,
    preferences::{self, Preferences},
    ui, ui_controls,
};
use anyhow::{Context, Result};
use crossterm::{
    cursor,
    event::{
        self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
        Event, KeyEventKind, MouseButton, MouseEventKind,
    },
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{Terminal, TerminalOptions, Viewport, backend::CrosstermBackend, layout::Rect};
use serde_json::{Value, json};
use std::{
    cell::Cell,
    collections::HashMap,
    io::{self, Write},
    path::Path,
    rc::Rc,
    time::{Duration, Instant},
};

struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> Result<Self> {
        enable_raw_mode().context("Cannot enable terminal raw mode")?;
        let guard = Self;
        execute!(
            io::stdout(),
            EnterAlternateScreen,
            EnableMouseCapture,
            EnableBracketedPaste
        )
        .context("Cannot initialize the terminal")?;
        Ok(guard)
    }
}

fn restore_terminal() {
    let _ = disable_raw_mode();
    let _ = execute!(
        io::stdout(),
        DisableBracketedPaste,
        DisableMouseCapture,
        LeaveAlternateScreen,
        cursor::Show
    );
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore_terminal();
    }
}

pub fn run(connection: &mut Connection, pairing_path: &Path, animate: bool) -> Result<()> {
    // Panic diagnostics must appear after restoring the user's terminal as well.
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore_terminal();
        previous_hook(info);
    }));
    let _guard = TerminalGuard::enter()?;
    let (cols, rows) = crossterm::terminal::size()?;
    let mut area = Rect::new(0, 0, cols, rows);
    // Windows console size queries are synchronous round trips. Query once,
    // then use resize events, including inside Ratatui's draw path.
    let batching = Rc::new(Cell::new(false));
    let mut terminal = Terminal::with_options(
        CrosstermBackend::new(FrameWriter::new(io::stdout(), batching.clone())),
        TerminalOptions {
            viewport: Viewport::Fixed(area),
        },
    )?;
    terminal.clear()?;
    let mut app = App::new(connection.client_id);
    app.dialog = Some(Dialog::Menu);
    let preferences_path = match preferences::default_path() {
        Ok(path) => Some(path),
        Err(_) => {
            app.notice = "Preferences unavailable; changes apply only to this run.".into();
            None
        }
    };
    let mut saved_preferences = preferences_path
        .as_deref()
        .and_then(|path| match Preferences::load(path) {
            Ok(preferences) => Some(preferences),
            Err(_) => {
                app.notice = "Saved preferences could not be loaded; using defaults.".into();
                None
            }
        })
        .unwrap_or_default();
    app.theme = saved_preferences.theme;
    app.onboarded = saved_preferences.onboarded;
    app.fullscreen_default = saved_preferences.fullscreen_default;
    app.fullscreen = saved_preferences.fullscreen_default;
    app.pairing_path = pairing_path.display().to_string();
    app.pairing_qr_path = pairing_path
        .with_file_name("pairing.svg")
        .display()
        .to_string();
    connection.send(json!({"type":"getCapabilities"}))?;
    let mut requested_sizes = HashMap::new();
    let mut last_draw = Instant::now() - Duration::from_secs(1);
    let mut dirty = true;
    let animation_started = Instant::now();
    let mut logo_frame = 0;
    loop {
        let phase = Instant::now();
        // Bound each drain so high-output sessions cannot starve the keyboard.
        for _ in 0..128 {
            match connection.events.try_recv() {
                Ok(NetworkEvent::Message(message)) => {
                    let commands = app.event(message).context("Invalid host event")?;
                    dispatch(connection, commands)?;
                    dirty = true;
                }
                Ok(NetworkEvent::Disconnected(message)) => {
                    app.disconnect(message);
                    dirty = true;
                }
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                    if app.connected {
                        app.disconnect(
                            "Disconnected. Quit and reconnect; host sessions remain running."
                                .into(),
                        );
                        dirty = true;
                    }
                    break;
                }
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => break,
            }
            if phase.elapsed() >= Duration::from_millis(4) {
                break;
            }
        }
        dispatch(
            connection,
            resize_commands(&app, area, &mut requested_sizes),
        )?;
        let next_logo_frame = logo_frame_for(&app, area, animate, animation_started.elapsed());
        if next_logo_frame != logo_frame {
            logo_frame = next_logo_frame;
            dirty = true;
        }
        if dirty && last_draw.elapsed() >= Duration::from_millis(16) {
            batching.set(true);
            terminal.draw(|frame| ui::render(frame, &app, logo_frame))?;
            // Crossterm flushes after cursor commands too. Assemble the complete
            // diff and cursor update first, then make one console write per frame.
            batching.set(false);
            terminal.backend_mut().flush()?;
            last_draw = Instant::now();
            dirty = false;
        }
        if event::poll(Duration::from_millis(16))? {
            let ev = event::read()?;
            if !affects_view(&ev) {
                continue;
            }
            if let Event::Resize(cols, rows) = ev {
                let next = Rect::new(0, 0, cols, rows);
                if cols > 0 && rows > 0 && area != next {
                    area = next;
                    terminal.resize(area)?;
                }
            }
            let outcome = controller::event(&mut app, ev, area);
            if outcome.quit {
                break;
            }
            dispatch(connection, outcome.commands)?;
            dirty |= outcome.redraw;
            let current_preferences = Preferences {
                theme: app.theme,
                onboarded: app.onboarded,
                fullscreen_default: app.fullscreen_default,
            };
            if current_preferences != saved_preferences {
                if let Some(path) = &preferences_path
                    && current_preferences.save(path).is_err()
                {
                    app.notice = "Could not save preferences; changes apply to this run.".into();
                }
                // A failed write must not turn into I/O on every render frame.
                saved_preferences = current_preferences;
                dirty = true;
            }
        }
    }
    Ok(())
}

fn logo_frame_for(app: &App, area: Rect, animate: bool, elapsed: Duration) -> usize {
    if !animate {
        return 0;
    }
    if matches!(app.dialog, Some(Dialog::Menu)) {
        return if brand::area(ui_controls::menu_area(area)).is_some() {
            brand::frame_index(elapsed)
        } else {
            0
        };
    }
    if app.dialog.is_some() || app.panes.iter().any(Option::is_some) {
        return 0;
    }
    let geometry = ui::geometry(area, app);
    let visible = (0..if app.split { 2 } else { 1 }).any(|index| {
        brand::area(ui::pane_content(geometry.panes[index], app.fullscreen)).is_some()
    });
    if visible {
        brand::frame_index(elapsed)
    } else {
        0
    }
}

fn affects_view(event: &Event) -> bool {
    match event {
        Event::Key(key) => key.kind != KeyEventKind::Release,
        Event::Paste(_) | Event::Resize(..) => true,
        Event::Mouse(mouse) => matches!(
            mouse.kind,
            MouseEventKind::Down(MouseButton::Left)
                | MouseEventKind::ScrollUp
                | MouseEventKind::ScrollDown
        ),
        _ => false,
    }
}

fn dispatch(connection: &Connection, commands: Vec<Value>) -> Result<()> {
    for command in commands {
        connection.send(command)?;
    }
    Ok(())
}

type RequestedSizes = HashMap<String, (String, u16, u16)>;

fn resize_commands(app: &App, area: Rect, requested: &mut RequestedSizes) -> Vec<Value> {
    let mut commands = Vec::new();
    requested.retain(|id, _| app.owns(id));
    let geometry = ui::geometry(area, app);
    for index in 0..if app.split { 2 } else { 1 } {
        if geometry.panes[index].is_empty() {
            continue;
        }
        let Some(id) = app.panes[index].as_deref() else {
            continue;
        };
        if !app.owns(id) {
            continue;
        }
        let Some(lease) = app.leases.get(id) else {
            continue;
        };
        let inner = ui::pane_content(geometry.panes[index], app.fullscreen);
        let cols = inner.width.clamp(10, 300);
        let rows = inner.height.clamp(2, 150);
        let wanted = (lease.clone(), cols, rows);
        if requested.get(id) == Some(&wanted) {
            continue;
        }
        requested.insert(id.into(), wanted);
        if app
            .session(id)
            .is_some_and(|session| session.cols == cols && session.rows == rows)
        {
            continue;
        }
        commands
            .push(json!({"type":"resize","sessionId":id,"leaseId":lease,"cols":cols,"rows":rows}));
    }
    commands
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseEvent};

    #[test]
    fn animation_only_advances_on_visible_empty_home_and_respects_static_mode() {
        let mut app = App::new(1);
        let area = Rect::new(0, 0, 120, 36);
        let blink = Duration::from_millis(840);
        assert_ne!(logo_frame_for(&app, area, true, blink), 0);
        assert_eq!(logo_frame_for(&app, area, false, blink), 0);
        assert_eq!(
            logo_frame_for(&app, Rect::new(0, 0, 45, 12), true, blink),
            0
        );
        app.dialog = Some(crate::model::Dialog::Help);
        assert_eq!(logo_frame_for(&app, area, true, blink), 0);
        app.dialog = None;
        // Even when the other split pane is empty, terminal activity must not
        // gain any periodic redraws from the decorative logo.
        app.split = true;
        app.panes[0] = Some("active-session".into());
        assert_eq!(logo_frame_for(&app, area, true, blink), 0);
        app.dialog = Some(Dialog::Menu);
        assert_ne!(logo_frame_for(&app, area, true, blink), 0);
        assert_eq!(logo_frame_for(&app, area, false, blink), 0);
        app.dialog = Some(Dialog::Theme { selected: 0 });
        assert_eq!(logo_frame_for(&app, area, true, blink), 0);
    }

    #[test]
    fn key_release_and_mouse_motion_do_not_schedule_console_writes() {
        assert!(!affects_view(&Event::Key(KeyEvent::new_with_kind(
            KeyCode::Char('a'),
            KeyModifiers::NONE,
            KeyEventKind::Release,
        ))));
        let mouse = MouseEvent {
            kind: MouseEventKind::Moved,
            column: 4,
            row: 5,
            modifiers: KeyModifiers::NONE,
        };
        assert!(!affects_view(&Event::Mouse(mouse)));
        assert!(affects_view(&Event::Mouse(MouseEvent {
            kind: MouseEventKind::ScrollUp,
            ..mouse
        })));
        assert!(affects_view(&Event::Resize(100, 40)));
    }

    #[test]
    fn observer_never_resizes_and_owner_resizes_once_per_dimension() {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","revision":0,"groups":[],"sessions":[
            {"id":"s","name":"shell","cwd":".","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        let mut requested = HashMap::new();
        let area = Rect::new(0, 0, 120, 40);
        assert!(resize_commands(&app, area, &mut requested).is_empty());
        app.event(json!({"type":"control","sessionId":"s","controllerId":1,"cols":80,"rows":24,"leaseId":"one"})).unwrap();
        assert_eq!(resize_commands(&app, area, &mut requested).len(), 1);
        assert!(resize_commands(&app, area, &mut requested).is_empty());
        app.event(json!({"type":"control","sessionId":"s","controllerId":2,"cols":80,"rows":24}))
            .unwrap();
        assert!(resize_commands(&app, Rect::new(0, 0, 100, 30), &mut requested).is_empty());
    }
}
