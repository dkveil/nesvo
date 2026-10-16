//! Platform terminal lifecycle and application effects. Rendering stays pure.
use crate::{
    controller,
    model::App,
    network::{Connection, NetworkEvent},
    ui,
};
use anyhow::{Context, Result};
use crossterm::{
    cursor,
    event::{
        self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    },
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{Terminal, backend::CrosstermBackend, layout::Rect};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{self, Stdout},
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

pub fn run(connection: &mut Connection) -> Result<()> {
    // Panic diagnostics must appear after restoring the user's terminal as well.
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore_terminal();
        previous_hook(info);
    }));
    let _guard = TerminalGuard::enter()?;
    let mut terminal: Terminal<CrosstermBackend<Stdout>> =
        Terminal::new(CrosstermBackend::new(io::stdout()))?;
    terminal.clear()?;
    let mut app = App::new(connection.client_id);
    let mut requested_sizes = HashMap::new();
    let mut last_draw = Instant::now() - Duration::from_secs(1);
    let mut dirty = true;
    loop {
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
        }
        let size = terminal.size()?;
        let area = Rect::new(0, 0, size.width, size.height);
        dispatch(
            connection,
            resize_commands(&app, area, &mut requested_sizes),
        )?;
        if dirty && last_draw.elapsed() >= Duration::from_millis(16) {
            terminal.draw(|frame| ui::render(frame, &app))?;
            last_draw = Instant::now();
            dirty = false;
        }
        if event::poll(Duration::from_millis(16))? {
            let outcome = controller::event(&mut app, event::read()?, area);
            if outcome.quit {
                break;
            }
            dispatch(connection, outcome.commands)?;
            dirty = true;
        }
    }
    Ok(())
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
    let geometry = ui::geometry(area, app.split);
    for index in 0..if app.split { 2 } else { 1 } {
        let Some(id) = app.panes[index].as_deref() else {
            continue;
        };
        if !app.owns(id) {
            continue;
        }
        let Some(lease) = app.leases.get(id) else {
            continue;
        };
        let inner = ui::pane_content(geometry.panes[index]);
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
