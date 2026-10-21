//! Platform terminal lifecycle and application effects. Rendering stays pure.
use crate::{
    brand, controller,
    model::{App, Dialog},
    network::{Connection, NetworkEvent, Pairing},
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
use tokio::sync::oneshot;

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

pub fn run(
    connection: &mut Connection,
    pairing_path: &Path,
    override_url: Option<&str>,
    animate: bool,
) -> Result<()> {
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
    app.ascii_icons = std::env::var_os("NESVO_ASCII_ICONS").is_some();
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
    app.shortcuts = saved_preferences.shortcuts;
    app.onboarded = saved_preferences.onboarded;
    if !app.onboarded {
        app.overlay = Some(crate::toolbox::Overlay::Onboarding(0));
    }
    app.fullscreen_default = saved_preferences.fullscreen_default;
    app.fullscreen = saved_preferences.fullscreen_default;
    app.pairing_path = pairing_path.display().to_string();
    app.pairing_qr_path = pairing_path
        .with_file_name("pairing.svg")
        .display()
        .to_string();
    send_or_disconnect(
        &mut app,
        connection,
        vec![json!({"type":"getCapabilities"})],
    );
    let layout_path = preferences_path.as_ref().and_then(|path| {
        Pairing::load(pairing_path, override_url)
            .ok()
            .map(|pairing| path.with_file_name(format!("workspace-{}.json", pairing.local_id())))
    });
    let mut saved_layout = layout_path
        .as_deref()
        .and_then(|path| crate::workspace_layout::WorkspaceLayout::load(path).ok());
    if let Some(layout) = &saved_layout {
        app.layouts = layout.library();
    }
    let mut layout_loaded = false;
    let mut project_default_pending = true;
    let mut layout_saved_at = Instant::now();
    let mut runtime_updated_at = Instant::now();
    let mut requested_sizes = HashMap::new();
    let mut last_draw = Instant::now() - Duration::from_secs(1);
    let mut dirty = true;
    let animation_started = Instant::now();
    let mut logo_frame = 0;
    let mut reconnect_started: Option<Instant> = None;
    let mut next_attempt = Instant::now();
    let mut reconnecting: Option<oneshot::Receiver<Result<Connection>>> = None;
    let mut resume_session: Option<String> = None;
    let mut clipboard_pending = false;
    let (clipboard_tx, clipboard_rx) = std::sync::mpsc::channel();
    loop {
        if let Ok(message) = clipboard_rx.try_recv() {
            clipboard_pending = false;
            app.toast = Some((message, Instant::now() + Duration::from_secs(3)));
            dirty = true;
        }
        if app
            .toast
            .as_ref()
            .is_some_and(|(_, until)| Instant::now() >= *until)
        {
            app.toast = None;
            dirty = true;
        }
        let menu_phase =
            if animate && matches!(app.dialog, Some(Dialog::Menu)) && app.overlay.is_none() {
                ((animation_started.elapsed().as_millis() / 100) % 40) as u8
            } else {
                0
            };
        if app.menu_phase != menu_phase {
            app.menu_phase = menu_phase;
            dirty = true;
        }
        let phase = Instant::now();
        if runtime_updated_at.elapsed() >= Duration::from_secs(1) {
            dirty |= app.refresh_session_times(phase);
            runtime_updated_at = phase;
        }
        if layout_loaded && app.connected && layout_saved_at.elapsed() >= Duration::from_secs(1) {
            let current = crate::workspace_layout::WorkspaceLayout::capture(&app);
            if saved_layout.as_ref() != Some(&current) {
                if let Some(path) = &layout_path
                    && current.save(path).is_err()
                {
                    app.notice = "Could not save the workspace layout.".into();
                    dirty = true;
                }
                saved_layout = Some(current);
            }
            layout_saved_at = Instant::now();
        }
        // Bound each drain so high-output sessions cannot starve the keyboard.
        for _ in 0..128 {
            match connection.events.try_recv() {
                Ok(NetworkEvent::Message(message)) => {
                    if !app.connected {
                        break;
                    }
                    let is_snapshot = message["type"] == "sessions";
                    let commands = app.event(message).context("Invalid host event")?;
                    send_or_disconnect(&mut app, connection, commands);
                    if is_snapshot && !layout_loaded && !app.sessions.is_empty() {
                        if let Some(layout) = &saved_layout {
                            let commands = layout.apply(&mut app);
                            send_or_disconnect(&mut app, connection, commands);
                        }
                        if std::mem::take(&mut project_default_pending)
                            && let Some(default) =
                                app.layouts.startup_layout(app.project_key().as_deref())
                            && let Ok(commands) =
                                crate::layouts::apply(&mut app, &default, area.width)
                        {
                            send_or_disconnect(&mut app, connection, commands);
                        }
                        layout_loaded = true;
                    }
                    if is_snapshot
                        && app.connected
                        && let Some(id) =
                            resume_session.take().filter(|id| app.session(id).is_some())
                    {
                        let commands = app.open_session(&id);
                        send_or_disconnect(&mut app, connection, commands);
                    }
                    dirty = true;
                }
                Ok(NetworkEvent::Disconnected(message)) => {
                    app.disconnect(message);
                    dirty = true;
                    break;
                }
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                    if app.connected {
                        app.disconnect("Host connection lost. Reconnecting…".into());
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
        if let Some(command) = app.auto_refresh_diff() {
            send_or_disconnect(&mut app, connection, vec![command]);
        }
        if !app.connected {
            remember_disconnected_session(&app, &mut resume_session);
            let started = *reconnect_started.get_or_insert_with(Instant::now);
            if started.elapsed() >= Duration::from_secs(20) {
                anyhow::bail!(
                    "Could not reconnect to the host within 20 seconds. Start nesvo-dev again after checking the host."
                );
            }
            if let Some(receiver) = &mut reconnecting {
                match receiver.try_recv() {
                    Ok(Ok(new_connection)) => {
                        *connection = new_connection;
                        saved_layout =
                            Some(crate::workspace_layout::WorkspaceLayout::capture(&app));
                        layout_loaded = false;
                        let mut next_app = App::new(connection.client_id);
                        next_app.sidebar_width = app.sidebar_width;
                        next_app.layouts = app.layouts.clone();
                        next_app.ascii_icons = app.ascii_icons;
                        next_app.shortcuts = app.shortcuts;
                        next_app.theme = app.theme;
                        next_app.onboarded = app.onboarded;
                        next_app.fullscreen_default = app.fullscreen_default;
                        next_app.fullscreen = app.fullscreen;
                        next_app.pairing_path = app.pairing_path.clone();
                        next_app.pairing_qr_path = app.pairing_qr_path.clone();
                        next_app.notice = "Reconnected to host.".into();
                        app = next_app;
                        requested_sizes.clear();
                        reconnect_started = None;
                        reconnecting = None;
                        send_or_disconnect(
                            &mut app,
                            connection,
                            vec![json!({"type":"getCapabilities"})],
                        );
                        dirty = true;
                    }
                    Ok(Err(_)) | Err(oneshot::error::TryRecvError::Closed) => {
                        reconnecting = None;
                        next_attempt = Instant::now() + Duration::from_millis(1200);
                        dirty = true;
                    }
                    Err(oneshot::error::TryRecvError::Empty) => {}
                }
            } else if Instant::now() >= next_attempt {
                let (sender, receiver) = oneshot::channel();
                let path = pairing_path.to_path_buf();
                let url = override_url.map(str::to_owned);
                tokio::spawn(async move {
                    let result = match Pairing::load(&path, url.as_deref()) {
                        Ok(pairing) => Connection::open(pairing).await,
                        Err(error) => Err(error),
                    };
                    let _ = sender.send(result);
                });
                reconnecting = Some(receiver);
                dirty = true;
            }
        } else {
            let commands = resize_commands(&app, area, &mut requested_sizes);
            send_or_disconnect(&mut app, connection, commands);
        }
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
            if !app.connected {
                if matches!(ev, Event::Key(key) if key.code == crossterm::event::KeyCode::Char('c') && key.modifiers.contains(crossterm::event::KeyModifiers::CONTROL))
                {
                    break;
                }
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
            if let Some(text) = outcome.clipboard
                && !clipboard_pending
            {
                clipboard_pending = true;
                let tx = clipboard_tx.clone();
                std::thread::spawn(move || {
                    let message = match copy_text(&text) {
                        Ok(()) => "Copied to clipboard.",
                        Err(_) => "Clipboard unavailable; copying failed.",
                    };
                    let _ = tx.send(message.to_owned());
                });
            }
            if outcome.quit {
                if layout_loaded
                    && app.connected
                    && let Some(path) = &layout_path
                {
                    let _ = crate::workspace_layout::WorkspaceLayout::capture(&app).save(path);
                }
                break;
            }
            send_or_disconnect(&mut app, connection, outcome.commands);
            dirty |= outcome.redraw;
            let current_preferences = Preferences {
                theme: match app.overlay {
                    Some(crate::toolbox::Overlay::Themes(_, original)) => original,
                    _ => app.theme,
                },
                shortcuts: app.shortcuts,
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

// Only a lost connection may arm a one-shot selection restore. Healthy
// snapshots must never reopen the pane: open_session deliberately leaves input.
fn remember_disconnected_session(app: &App, pending: &mut Option<String>) {
    if !app.connected && pending.is_none() {
        *pending = app.active_id().map(str::to_owned);
    }
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
    let visible = (0..app.leaf_count()).any(|index| {
        brand::area(ui::pane_content(geometry.panes[index], ui::immersive(app))).is_some()
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
                | MouseEventKind::Drag(MouseButton::Left)
                | MouseEventKind::Up(MouseButton::Left)
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

fn send_or_disconnect(app: &mut App, connection: &Connection, commands: Vec<Value>) {
    if app.connected
        && let Err(error) = dispatch(connection, commands)
    {
        if connection.is_closed() {
            app.disconnect("Host connection lost. Reconnecting…".into());
        } else {
            app.notice = error.to_string();
        }
    }
}

type RequestedSizes = HashMap<String, (String, u16, u16)>;

fn resize_commands(app: &App, area: Rect, requested: &mut RequestedSizes) -> Vec<Value> {
    let mut commands = Vec::new();
    requested.retain(|id, _| app.owns(id));
    let geometry = ui::geometry(area, app);
    for index in 0..app.leaf_count() {
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
        let inner = ui::pane_content(geometry.panes[index], ui::immersive(app));
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

#[cfg(windows)]
fn copy_text(text: &str) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command",
            "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(); Set-Clipboard -Value ([Console]::In.ReadToEnd())"])
        .creation_flags(0x08000000)
        .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes())?;
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait()? {
            return if status.success() {
                Ok(())
            } else {
                Err(io::Error::other("Clipboard failed"))
            };
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("Clipboard timed out"));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(not(windows))]
fn copy_text(text: &str) -> io::Result<()> {
    execute!(
        io::stdout(),
        crossterm::clipboard::CopyToClipboard::to_clipboard_from(text)
    )
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
        app.dialog = Some(Dialog::Settings { selected: 0 });
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
    #[test]
    fn healthy_updates_never_arm_reconnect_selection() {
        let mut app = App::new(1);
        app.panes[0] = Some("session".into());
        app.mode = crate::model::Mode::Input;
        let mut pending = None;
        for _ in 0..20 {
            remember_disconnected_session(&app, &mut pending);
        }
        assert!(pending.is_none());
        assert!(app.mode == crate::model::Mode::Input);
        app.disconnect("lost".into());
        remember_disconnected_session(&app, &mut pending);
        assert_eq!(pending.as_deref(), Some("session"));
        app.panes[0] = Some("different".into());
        remember_disconnected_session(&app, &mut pending);
        assert_eq!(pending.as_deref(), Some("session"));
    }
}
