//! Native PTY ownership and blocking process I/O adapters.
use anyhow::{Result, anyhow};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
#[cfg(windows)]
use std::time::Duration;
use std::{
    io::{Read, Write},
    sync::mpsc as sync_mpsc,
    thread,
};
use tokio::sync::mpsc;

pub enum PtyEvent {
    Data(String, String),
    Exited(String, Option<u32>),
    InputError(String),
}

pub struct Pty {
    // Close the input channel before ConPTY's potentially blocking destructor.
    input: sync_mpsc::SyncSender<Input>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

struct Input {
    data: String,
    flushed: Option<sync_mpsc::Sender<bool>>,
}

impl Pty {
    pub fn spawn(
        id: &str,
        command: CommandBuilder,
        size: PtySize,
        events: mpsc::Sender<PtyEvent>,
    ) -> Result<Self> {
        let pair = native_pty_system().openpty(size)?;
        let mut child = pair.slave.spawn_command(command)?;
        drop(pair.slave);
        let killer = crate::process::killer(child.as_ref())?;
        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        let (input_tx, input_rx) = sync_mpsc::sync_channel::<Input>(16);
        let input_id = id.to_owned();
        let input_events = events.clone();
        thread::spawn(move || {
            while let Ok(input) = input_rx.recv() {
                let written = writer
                    .write_all(input.data.as_bytes())
                    .and_then(|_| writer.flush())
                    .is_ok();
                if let Some(flushed) = input.flushed {
                    let _ = flushed.send(written);
                }
                if !written {
                    let _ = input_events.blocking_send(PtyEvent::InputError(input_id));
                    break;
                }
            }
        });
        let reader_id = id.to_owned();
        let reader_events = events.clone();
        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            let mut pending = Vec::new();
            while let Ok(length) = reader.read(&mut buffer) {
                if length == 0 {
                    break;
                }
                pending.extend_from_slice(&buffer[..length]);
                let (valid, keep) = match std::str::from_utf8(&pending) {
                    Ok(text) => (text.to_owned(), 0),
                    Err(error) if error.error_len().is_none() => (
                        String::from_utf8_lossy(&pending[..error.valid_up_to()]).into_owned(),
                        pending.len() - error.valid_up_to(),
                    ),
                    Err(_) => (String::from_utf8_lossy(&pending).into_owned(), 0),
                };
                if !valid.is_empty()
                    && reader_events
                        .blocking_send(PtyEvent::Data(reader_id.to_owned(), valid))
                        .is_err()
                {
                    break;
                }
                pending.drain(..pending.len() - keep);
            }
        });
        let wait_id = id.to_owned();
        thread::spawn(move || {
            let exit = child.wait().ok().map(|status| status.exit_code());
            let _ = events.blocking_send(PtyEvent::Exited(wait_id, exit));
        });

        Ok(Self {
            input: input_tx,
            master: pair.master,
            killer,
        })
    }

    pub fn send_input(&self, data: String) -> Result<()> {
        self.input
            .try_send(Input {
                data,
                flushed: None,
            })
            .map_err(|_| anyhow!("Terminal input queue is full or closed. Input was not sent."))
    }

    /// Release ConPTY's initial cursor-position handshake when a session is
    /// closed before any terminal has been attached to answer it.
    #[cfg(windows)]
    pub fn answer_unattached_cursor_query(&self) -> Result<()> {
        let (flushed_tx, flushed_rx) = sync_mpsc::channel();
        self.input
            .try_send(Input {
                data: "\x1b[1;1R".into(),
                flushed: Some(flushed_tx),
            })
            .map_err(|_| anyhow!("Terminal input queue is full or closed."))?;
        let written = flushed_rx
            .recv_timeout(Duration::from_secs(1))
            .map_err(|_| anyhow!("Timed out answering ConPTY's startup cursor query."))?;
        if !written {
            return Err(anyhow!("Could not answer ConPTY's startup cursor query."));
        }
        Ok(())
    }

    pub fn resize(&self, size: PtySize) -> Result<()> {
        self.master.resize(size)
    }
    pub fn kill(&mut self) -> Result<()> {
        Ok(self.killer.kill()?)
    }
}
