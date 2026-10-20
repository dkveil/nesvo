//! Bounded test-only ordering evidence; no terminal contents or production cost.
use super::{Confirmation, Input};
use std::sync::{Arc, Mutex, mpsc};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InputTraceKind {
    Unconfirmed,
    Receipt,
    #[cfg(windows)]
    Cleanup,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InputTracePhase {
    Queued,
    WriteStarted,
    WriteFinished,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputTraceEvent {
    pub sequence: u64,
    pub input_id: u64,
    pub kind: InputTraceKind,
    pub phase: InputTracePhase,
    pub bytes: usize,
    pub written: Option<bool>,
}

struct State {
    input_sequence: u64,
    event_sequence: u64,
    events: mpsc::SyncSender<InputTraceEvent>,
}

#[derive(Clone)]
pub(super) struct Trace(Arc<Mutex<State>>);

#[derive(Clone)]
pub(super) struct Envelope {
    trace: Trace,
    input_id: u64,
    kind: InputTraceKind,
    bytes: usize,
}

impl State {
    fn record(&mut self, envelope: &Envelope, phase: InputTracePhase, written: Option<bool>) {
        self.event_sequence += 1;
        let _ = self.events.try_send(InputTraceEvent {
            sequence: self.event_sequence,
            input_id: envelope.input_id,
            kind: envelope.kind,
            phase,
            bytes: envelope.bytes,
            written,
        });
    }
}

impl Trace {
    pub(super) fn new() -> (Self, mpsc::Receiver<InputTraceEvent>) {
        let (events, receiver) = mpsc::sync_channel(64);
        (
            Self(Arc::new(Mutex::new(State {
                input_sequence: 0,
                event_sequence: 0,
                events,
            }))),
            receiver,
        )
    }

    pub(super) fn enqueue(
        &self,
        sender: &mpsc::SyncSender<Input>,
        data: String,
        confirmation: Option<Confirmation>,
    ) -> Result<(), mpsc::TrySendError<Input>> {
        // The writer's trace lock cannot pass this admission record. try_send
        // never waits for native I/O, including when its queue is already full.
        let mut state = self.0.lock().unwrap();
        state.input_sequence += 1;
        let envelope = Envelope {
            trace: self.clone(),
            input_id: state.input_sequence,
            kind: match confirmation.as_ref() {
                Some(Confirmation::Receipt(_)) => InputTraceKind::Receipt,
                #[cfg(windows)]
                Some(Confirmation::Cleanup(_)) => InputTraceKind::Cleanup,
                None => InputTraceKind::Unconfirmed,
            },
            bytes: data.len(),
        };
        sender.try_send(Input {
            data,
            confirmation,
            trace: Some(envelope.clone()),
        })?;
        state.record(&envelope, InputTracePhase::Queued, None);
        Ok(())
    }
}

impl Envelope {
    pub(super) fn started(&self) {
        self.trace
            .0
            .lock()
            .unwrap()
            .record(self, InputTracePhase::WriteStarted, None);
    }

    pub(super) fn finished(&self, written: bool) {
        self.trace
            .0
            .lock()
            .unwrap()
            .record(self, InputTracePhase::WriteFinished, Some(written));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evidence_orders_queue_and_native_write_without_retaining_contents() {
        let (trace, evidence) = Trace::new();
        let (sender, inputs) = mpsc::sync_channel(1);
        let (confirmation, receipt) = tokio::sync::oneshot::channel();
        assert!(
            trace
                .enqueue(
                    &sender,
                    "private payload".into(),
                    Some(Confirmation::Receipt(confirmation)),
                )
                .is_ok()
        );
        let input = inputs.recv().unwrap();
        let mut writer = Vec::new();
        assert!(super::super::write_input(&mut writer, input));
        assert!(receipt.blocking_recv().unwrap());
        let events = evidence.try_iter().collect::<Vec<_>>();
        assert_eq!(events.len(), 3);
        for (index, event) in events.iter().enumerate() {
            assert_eq!(event.sequence, index as u64 + 1);
            assert_eq!(event.input_id, 1);
            assert_eq!(event.kind, InputTraceKind::Receipt);
        }
        assert_eq!(events[0].phase, InputTracePhase::Queued);
        assert_eq!(events[1].phase, InputTracePhase::WriteStarted);
        assert_eq!(events[2].phase, InputTracePhase::WriteFinished);
        assert_eq!(events[2].written, Some(true));
        let public = serde_json::to_string(&events).unwrap();
        assert!(!public.contains("private"));
        assert!(!public.contains("payload"));
    }

    #[test]
    fn full_or_disconnected_observation_never_blocks_or_replays_native_bytes() {
        let (trace, evidence) = Trace::new();
        let (sender, inputs) = mpsc::sync_channel(1);
        for _ in 0..32 {
            assert!(trace.enqueue(&sender, "once".into(), None).is_ok());
            assert!(super::super::write_input(
                &mut Vec::new(),
                inputs.recv().unwrap()
            ));
        }
        assert_eq!(evidence.try_iter().count(), 64);
        drop(evidence);
        assert!(trace.enqueue(&sender, "still once".into(), None).is_ok());
        assert!(super::super::write_input(
            &mut Vec::new(),
            inputs.recv().unwrap()
        ));
        assert!(trace.enqueue(&sender, "queued".into(), None).is_ok());
        assert!(trace.enqueue(&sender, "refused".into(), None).is_err());
        assert_eq!(inputs.recv().unwrap().data, "queued");
        assert!(inputs.try_recv().is_err());
    }
}
