//! Explicit, bounded startup evidence. Disabled for helpers and ordinary startup.
use serde::Serialize;
use std::{
    ffi::OsStr,
    io::Write,
    sync::{Arc, Mutex},
    time::Instant,
};

const PREFIX: &str = "NESVO_STARTUP_PHASE ";
const MAX_RECORDS: u64 = 128;
const MAX_LINE_BYTES: usize = 256;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Phase {
    RuntimeCreate,
    WorkspaceResolve,
    ListenerBind,
    AdvertiseResolve,
    PairingDirectory,
    HostLock,
    #[cfg(unix)]
    PairingPermissions,
    PairingPrepare,
    MetadataOpen,
    JournalOpen,
    StartupEventAppend,
    LauncherDiscover,
    StateInitialize,
    WebhookBind,
    RuntimesInstall,
    ReadinessAnnounce,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum Event {
    Begin,
    End,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum Outcome {
    Ok,
    Failed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    schema_version: u8,
    sequence: u64,
    phase: Phase,
    event: Event,
    elapsed_ms: u64,
    duration_ms: Option<u64>,
    outcome: Option<Outcome>,
}

struct Emitter {
    origin: Instant,
    writer: Box<dyn Write + Send>,
    sequence: u64,
    failed: bool,
}

impl Emitter {
    fn emit(
        &mut self,
        phase: Phase,
        event: Event,
        started: Option<u64>,
        succeeded: Option<bool>,
    ) -> Option<u64> {
        let elapsed = u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.emit_at(phase, event, started, succeeded, elapsed)
    }

    fn emit_at(
        &mut self,
        phase: Phase,
        event: Event,
        started: Option<u64>,
        succeeded: Option<bool>,
        elapsed: u64,
    ) -> Option<u64> {
        if self.failed || self.sequence >= MAX_RECORDS {
            return None;
        }
        let record = Record {
            schema_version: 1,
            sequence: self.sequence + 1,
            phase,
            event,
            elapsed_ms: elapsed,
            duration_ms: started.map(|start| elapsed.saturating_sub(start)),
            outcome: succeeded.map(|success| {
                if success {
                    Outcome::Ok
                } else {
                    Outcome::Failed
                }
            }),
        };
        let Ok(body) = serde_json::to_string(&record) else {
            self.failed = true;
            return None;
        };
        let line = format!("{PREFIX}{body}\n");
        if line.len() > MAX_LINE_BYTES
            || self.writer.write_all(line.as_bytes()).is_err()
            || self.writer.flush().is_err()
        {
            // Diagnostic I/O must not replace the actual startup result or
            // panic on a closed pipe. Stop rather than retrying partial writes.
            self.failed = true;
            return None;
        }
        self.sequence += 1;
        Some(elapsed)
    }
}

#[derive(Clone, Default)]
pub(crate) struct Trace(Option<Arc<Mutex<Emitter>>>);

fn enabled(value: Option<&OsStr>) -> bool {
    value == Some(OsStr::new("1"))
}

impl Trace {
    pub(crate) fn from_env() -> Self {
        if enabled(std::env::var_os("NESVO_STARTUP_DIAGNOSTICS").as_deref()) {
            Self::with_writer(Box::new(std::io::stdout()))
        } else {
            Self::default()
        }
    }

    fn with_writer(writer: Box<dyn Write + Send>) -> Self {
        Self(Some(Arc::new(Mutex::new(Emitter {
            origin: Instant::now(),
            writer,
            sequence: 0,
            failed: false,
        }))))
    }

    pub(crate) fn begin(&self, phase: Phase) -> Span {
        let started = self
            .0
            .as_ref()
            .and_then(|inner| inner.lock().ok()?.emit(phase, Event::Begin, None, None));
        Span {
            trace: self.clone(),
            phase,
            started,
        }
    }
}

pub(crate) struct Span {
    trace: Trace,
    phase: Phase,
    started: Option<u64>,
}

impl Span {
    pub(crate) fn end(self, succeeded: bool) {
        if let (Some(inner), Some(started)) = (&self.trace.0, self.started)
            && let Ok(mut emitter) = inner.lock()
        {
            let _ = emitter.emit(self.phase, Event::End, Some(started), Some(succeeded));
        }
    }

    pub(crate) fn result<T, E>(self, result: Result<T, E>) -> Result<T, E> {
        self.end(result.is_ok());
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io;

    #[derive(Clone, Default)]
    struct Bytes(Arc<Mutex<Vec<u8>>>);

    impl Write for Bytes {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn records(bytes: &Bytes) -> Vec<Value> {
        String::from_utf8(bytes.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line.strip_prefix(PREFIX).unwrap()).unwrap())
            .collect()
    }

    #[test]
    fn disabled_trace_has_no_active_allocation_or_output_and_activation_is_exact() {
        let trace = Trace::default();
        assert!(trace.0.is_none());
        let span = trace.begin(Phase::RuntimeCreate);
        assert!(span.trace.0.is_none());
        span.end(true);
        for value in [
            None,
            Some(OsStr::new("")),
            Some(OsStr::new("true")),
            Some(OsStr::new("01")),
        ] {
            assert!(!enabled(value));
        }
        assert!(enabled(Some(OsStr::new("1"))));
    }

    #[test]
    fn begin_precedes_work_and_failure_result_is_returned_without_raw_payload() {
        let bytes = Bytes::default();
        let trace = Trace::with_writer(Box::new(bytes.clone()));
        let span = trace.begin(Phase::MetadataOpen);
        let before = records(&bytes);
        assert_eq!(before.len(), 1);
        assert_eq!(before[0]["event"], "begin");
        assert!(before[0]["outcome"].is_null());
        let raw = "private SQL /secret/path prompt-key-sentinel";
        let result: Result<(), &str> = span.result(Err(raw));
        assert_eq!(result, Err(raw));
        let after = records(&bytes);
        assert_eq!(after[1]["event"], "end");
        assert_eq!(after[1]["outcome"], "failed");
        assert!(
            !String::from_utf8(bytes.0.lock().unwrap().clone())
                .unwrap()
                .contains(raw)
        );
    }

    #[test]
    fn dropping_unfinished_span_never_invents_success_or_holds_the_writer() {
        let bytes = Bytes::default();
        let trace = Trace::with_writer(Box::new(bytes.clone()));
        let span = trace.begin(Phase::JournalOpen);
        assert!(trace.0.as_ref().unwrap().try_lock().is_ok());
        drop(span);
        assert_eq!(records(&bytes).len(), 1);
    }

    #[test]
    fn shared_trace_keeps_sequence_and_monotonic_duration_without_wall_clock() {
        let bytes = Bytes::default();
        let trace = Trace::with_writer(Box::new(bytes.clone()));
        {
            let mut writer = trace.0.as_ref().unwrap().lock().unwrap();
            let _ = writer.emit_at(Phase::MetadataOpen, Event::Begin, None, None, 40);
        }
        {
            let clone = trace.clone();
            let mut writer = clone.0.as_ref().unwrap().lock().unwrap();
            let _ = writer.emit_at(Phase::MetadataOpen, Event::End, Some(40), Some(true), 49);
        }
        let stored = records(&bytes);
        assert_eq!(stored[0]["sequence"], 1);
        assert_eq!(stored[1]["sequence"], 2);
        assert_eq!(stored[1]["elapsedMs"], 49);
        assert_eq!(stored[1]["durationMs"], 9);
    }

    struct FailedWriter {
        flush_only: bool,
        attempts: Arc<Mutex<usize>>,
    }
    impl Write for FailedWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            *self.attempts.lock().unwrap() += 1;
            if self.flush_only {
                Ok(bytes.len())
            } else {
                Err(io::Error::other("private write failure"))
            }
        }
        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::other("private flush failure"))
        }
    }

    #[test]
    fn write_and_flush_failures_stop_tracing_without_replacing_success_or_retrying() {
        for flush_only in [false, true] {
            let attempts = Arc::new(Mutex::new(0));
            let trace = Trace::with_writer(Box::new(FailedWriter {
                flush_only,
                attempts: attempts.clone(),
            }));
            assert_eq!(
                trace.begin(Phase::RuntimeCreate).result(Ok::<_, ()>(7)),
                Ok(7)
            );
            trace.begin(Phase::WorkspaceResolve).end(true);
            assert_eq!(*attempts.lock().unwrap(), 1);
        }
    }

    #[test]
    fn record_count_and_worst_case_numeric_lines_are_bounded() {
        let bytes = Bytes::default();
        let trace = Trace::with_writer(Box::new(bytes.clone()));
        let mut writer = trace.0.as_ref().unwrap().lock().unwrap();
        for _ in 0..MAX_RECORDS + 5 {
            let _ = writer.emit_at(
                Phase::StartupEventAppend,
                Event::End,
                Some(0),
                Some(false),
                u64::MAX,
            );
        }
        drop(writer);
        let raw = bytes.0.lock().unwrap();
        assert!(raw.len() <= 32 * 1024);
        assert_eq!(
            raw.iter().filter(|byte| **byte == b'\n').count(),
            MAX_RECORDS as usize
        );
        assert!(
            raw.split_inclusive(|byte| *byte == b'\n')
                .all(|line| line.len() <= MAX_LINE_BYTES)
        );
    }
}
