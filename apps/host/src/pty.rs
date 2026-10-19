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
use tokio::sync::{mpsc, oneshot};

pub enum PtyEvent {
    Data(String, String),
    Exited(String, Option<u32>),
    InputError(String),
}

pub struct Pty {
    process_id: Option<u32>,
    // Close the input channel before ConPTY's potentially blocking destructor.
    input: sync_mpsc::SyncSender<Input>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

struct Input {
    data: String,
    confirmation: Option<Confirmation>,
}

enum Confirmation {
    #[cfg(windows)]
    Cleanup(sync_mpsc::Sender<bool>),
    Receipt(oneshot::Sender<bool>),
}

fn write_input(writer: &mut impl Write, input: Input) -> bool {
    let written = writer
        .write_all(input.data.as_bytes())
        .and_then(|_| writer.flush())
        .is_ok();
    if let Some(confirmation) = input.confirmation {
        match confirmation {
            #[cfg(windows)]
            Confirmation::Cleanup(sender) => {
                let _ = sender.send(written);
            }
            Confirmation::Receipt(sender) => {
                let _ = sender.send(written);
            }
        }
    }
    written
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
        let process_id = child.process_id();
        drop(pair.slave);
        let killer = crate::process::killer(child.as_ref())?;
        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        let (input_tx, input_rx) = sync_mpsc::sync_channel::<Input>(16);
        let input_id = id.to_owned();
        let input_events = events.clone();
        thread::spawn(move || {
            while let Ok(input) = input_rx.recv() {
                let written = write_input(&mut writer, input);
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
            process_id,
            input: input_tx,
            master: pair.master,
            killer,
        })
    }

    pub fn send_input(&self, data: String) -> Result<()> {
        self.input
            .try_send(Input {
                data,
                confirmation: None,
            })
            .map_err(|_| anyhow!("Terminal input queue is full or closed. Input was not sent."))
    }

    /// Acknowledges native write+flush only, never provider pickup or completion.
    pub fn send_confirmed(&self, data: String) -> Result<oneshot::Receiver<bool>> {
        let (sender, answer) = oneshot::channel();
        self.input
            .try_send(Input {
                data,
                confirmation: Some(Confirmation::Receipt(sender)),
            })
            .map_err(|_| {
                anyhow!("Terminal input queue is full or closed. Input was not queued.")
            })?;
        Ok(answer)
    }
    pub fn process_id(&self) -> Option<u32> {
        self.process_id
    }

    /// Release ConPTY's initial cursor-position handshake when a session is
    /// closed before any terminal has been attached to answer it.
    #[cfg(windows)]
    pub fn answer_unattached_cursor_query(&self) -> Result<()> {
        let (flushed_tx, flushed_rx) = sync_mpsc::channel();
        self.input
            .try_send(Input {
                data: "\x1b[1;1R".into(),
                confirmation: Some(Confirmation::Cleanup(flushed_tx)),
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

#[cfg(test)]
mod tests {
    use super::*;
    struct Writer {
        bytes: Vec<u8>,
        flush_fails: bool,
        write_fails: bool,
    }
    impl Write for Writer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.write_fails {
                return Err(std::io::Error::other("fixture partial write"));
            }
            self.bytes.push(bytes[0]);
            if bytes.len() > 1 {
                self.write_fails = self.flush_fails;
            }
            Ok(1)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            if self.flush_fails {
                Err(std::io::Error::other("fixture flush"))
            } else {
                Ok(())
            }
        }
    }
    #[tokio::test]
    async fn receipt_waits_for_full_write_and_flush_and_does_not_hide_partial_failure() {
        for fails in [false, true] {
            let (sender, answer) = oneshot::channel();
            let mut writer = Writer {
                bytes: vec![],
                flush_fails: fails,
                write_fails: false,
            };
            let written = write_input(
                &mut writer,
                Input {
                    data: "literal łódź".into(),
                    confirmation: Some(Confirmation::Receipt(sender)),
                },
            );
            assert_eq!(answer.await.unwrap(), !fails);
            assert_eq!(written, !fails);
            if fails {
                assert_eq!(writer.bytes, b"l");
            } else {
                assert_eq!(writer.bytes, "literal łódź".as_bytes());
            }
        }
        let (sender, answer) = oneshot::channel();
        let mut flush_failure = Writer {
            bytes: vec![],
            flush_fails: true,
            write_fails: false,
        };
        assert!(!write_input(
            &mut flush_failure,
            Input {
                data: "x".into(),
                confirmation: Some(Confirmation::Receipt(sender))
            }
        ));
        assert!(!answer.await.unwrap());
        assert_eq!(
            flush_failure.bytes, b"x",
            "all bytes written is still not a successful flush"
        );
        let (sender, answer) = oneshot::channel();
        drop(answer);
        assert!(
            write_input(
                &mut Vec::new(),
                Input {
                    data: "still write once".into(),
                    confirmation: Some(Confirmation::Receipt(sender))
                }
            ),
            "a lost receipt never replays or cancels accepted bytes"
        );
    }
}
