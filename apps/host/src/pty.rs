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

#[cfg(test)]
#[path = "pty_input_trace.rs"]
mod input_trace;
#[cfg(test)]
pub use input_trace::{InputTraceEvent, InputTraceKind, InputTracePhase};

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
    #[cfg(test)]
    trace: Option<input_trace::Trace>,
}

struct Input {
    data: String,
    confirmation: Option<Confirmation>,
    #[cfg(test)]
    trace: Option<input_trace::Envelope>,
}

enum Confirmation {
    #[cfg(windows)]
    Cleanup(sync_mpsc::Sender<bool>),
    Receipt(oneshot::Sender<bool>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QueueAdmissionError {
    Full,
    Closed,
}
impl std::fmt::Display for QueueAdmissionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Keep the existing adapter message; only its private type is new.
        f.write_str("Terminal input queue is full or closed. Input was not queued.")
    }
}
impl std::error::Error for QueueAdmissionError {}

fn confirmed_enqueue(
    data: String,
    enqueue: impl FnOnce(
        String,
        Option<Confirmation>,
    ) -> std::result::Result<(), sync_mpsc::TrySendError<Input>>,
) -> Result<oneshot::Receiver<bool>> {
    let (sender, answer) = oneshot::channel();
    enqueue(data, Some(Confirmation::Receipt(sender))).map_err(|error| match error {
        sync_mpsc::TrySendError::Full(_) => QueueAdmissionError::Full,
        sync_mpsc::TrySendError::Disconnected(_) => QueueAdmissionError::Closed,
    })?;
    Ok(answer)
}

fn write_input(writer: &mut impl Write, input: Input) -> bool {
    #[cfg(test)]
    if let Some(trace) = &input.trace {
        trace.started();
    }
    let written = writer
        .write_all(input.data.as_bytes())
        .and_then(|_| writer.flush())
        .is_ok();
    #[cfg(test)]
    if let Some(trace) = &input.trace {
        trace.finished(written);
    }
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
    #[cfg(test)]
    pub fn trace_input(&mut self) -> sync_mpsc::Receiver<InputTraceEvent> {
        let (trace, receiver) = input_trace::Trace::new();
        self.trace = Some(trace);
        receiver
    }

    pub fn spawn(
        id: &str,
        command: CommandBuilder,
        size: PtySize,
        events: mpsc::Sender<PtyEvent>,
    ) -> Result<Self> {
        Self::spawn_internal(
            id,
            command,
            size,
            events,
            #[cfg(test)]
            None,
        )
    }

    #[cfg(all(test, windows))]
    pub fn spawn_traced(
        id: &str,
        command: CommandBuilder,
        size: PtySize,
        events: mpsc::Sender<PtyEvent>,
    ) -> Result<(Self, sync_mpsc::Receiver<InputTraceEvent>)> {
        let (trace, receiver) = input_trace::Trace::new();
        Ok((
            Self::spawn_internal(id, command, size, events, Some(trace))?,
            receiver,
        ))
    }

    fn spawn_internal(
        id: &str,
        command: CommandBuilder,
        size: PtySize,
        events: mpsc::Sender<PtyEvent>,
        #[cfg(test)] trace: Option<input_trace::Trace>,
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
        #[cfg(windows)]
        let mut descendants = killer.clone_killer();
        thread::spawn(move || {
            let exit = child.wait().ok().map(|status| status.exit_code());
            // A native root can exit while MCP helpers still own terminal pipes.
            // Request descendant termination before publishing the root exit;
            // acceptance still does not prove every process has been reaped.
            #[cfg(windows)]
            if let Err(error) = descendants.kill() {
                eprintln!("Native session descendant cleanup failed: {error}");
            }
            let _ = events.blocking_send(PtyEvent::Exited(wait_id, exit));
        });

        Ok(Self {
            process_id,
            input: input_tx,
            master: pair.master,
            killer,
            #[cfg(test)]
            trace,
        })
    }

    pub fn send_input(&self, data: String) -> Result<()> {
        self.enqueue(data, None)
            .map_err(|_| anyhow!("Terminal input queue is full or closed. Input was not sent."))
    }

    /// Acknowledges native write+flush only, never provider pickup or completion.
    pub fn send_confirmed(&self, data: String) -> Result<oneshot::Receiver<bool>> {
        confirmed_enqueue(data, |data, confirmation| self.enqueue(data, confirmation))
    }
    fn enqueue(
        &self,
        data: String,
        confirmation: Option<Confirmation>,
    ) -> std::result::Result<(), sync_mpsc::TrySendError<Input>> {
        #[cfg(test)]
        if let Some(trace) = &self.trace {
            return trace.enqueue(&self.input, data, confirmation);
        }
        self.input.try_send(Input {
            data,
            confirmation,
            #[cfg(test)]
            trace: None,
        })
    }
    pub fn process_id(&self) -> Option<u32> {
        self.process_id
    }

    /// Finish the initial ConPTY handshake and drain earlier input before kill.
    /// An empty barrier flushes an already queued reply without duplicating it.
    #[cfg(windows)]
    pub fn prepare_termination(&self, reply_initial_cursor: bool) -> Result<()> {
        let (flushed_tx, flushed_rx) = sync_mpsc::channel();
        self.enqueue(
            if reply_initial_cursor {
                "\x1b[1;1R"
            } else {
                ""
            }
            .into(),
            Some(Confirmation::Cleanup(flushed_tx)),
        )
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

    #[test]
    fn confirmed_admission_distinguishes_full_and_closed_without_queuing_bytes() {
        let (sender, inputs) = sync_mpsc::sync_channel(0);
        let error = confirmed_enqueue("PRIVATE_INPUT".into(), |data, confirmation| {
            sender.try_send(Input {
                data,
                confirmation,
                trace: None,
            })
        })
        .unwrap_err();
        assert_eq!(
            error.downcast_ref::<QueueAdmissionError>(),
            Some(&QueueAdmissionError::Full)
        );
        assert!(matches!(
            inputs.try_recv(),
            Err(sync_mpsc::TryRecvError::Empty)
        ));
        let mut writer = Vec::new();
        assert!(
            writer.is_empty(),
            "Rejected input must not reach the native writer"
        );
        drop(inputs);
        let error = confirmed_enqueue("PRIVATE_INPUT".into(), |data, confirmation| {
            sender.try_send(Input {
                data,
                confirmation,
                trace: None,
            })
        })
        .unwrap_err();
        assert_eq!(
            error.downcast_ref::<QueueAdmissionError>(),
            Some(&QueueAdmissionError::Closed)
        );
        assert_eq!(
            error.to_string(),
            "Terminal input queue is full or closed. Input was not queued."
        );
        assert!(!error.to_string().contains("PRIVATE_INPUT"));
        // A separate accepted input still exercises the unchanged real writer.
        let (sender, inputs) = sync_mpsc::sync_channel(1);
        let _answer = confirmed_enqueue("accepted once".into(), |data, confirmation| {
            sender.try_send(Input {
                data,
                confirmation,
                trace: None,
            })
        })
        .unwrap();
        assert!(write_input(&mut writer, inputs.recv().unwrap()));
        assert_eq!(writer, b"accepted once");
    }

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
                    trace: None,
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
                confirmation: Some(Confirmation::Receipt(sender)),
                trace: None,
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
                    confirmation: Some(Confirmation::Receipt(sender)),
                    trace: None,
                }
            ),
            "a lost receipt never replays or cancels accepted bytes"
        );
    }
}
