use super::*;
use crate::pty::{InputTraceEvent, InputTraceKind, InputTracePhase};
use std::os::windows::process::CommandExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use windows_sys::Win32::{
    Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{PROCESS_SYNCHRONIZE, WaitForSingleObject},
};

const HOLDER: &str = "process::windows::tests::input_fifo_probe::native_input_fifo_holder_fixture";
const PASTE: &str = "\x1b[200~report-task\x1b[201~";
const READY_LIMIT: Duration = Duration::from_secs(3);
const OBSERVATION_LIMIT: Duration = Duration::from_secs(2);

const NODE_CHILD: &str = r#"
'use strict';
const net = require('node:net');
const token = process.env.NESVO_INPUT_FIFO_TOKEN;
const control = net.createConnection({
  host: '127.0.0.1',
  port: Number(process.env.NESVO_INPUT_FIFO_PORT),
});
let requestedQuery = false;
const deadline = setTimeout(() => process.exit(0), 15000);
control.on('error', () => process.exit(2));
control.on('close', () => process.exit(0));
process.stdin.on('data', () => {});
process.stdin.on('error', () => {});
process.stdin.resume();
control.once('connect', () => {
  const ready = Buffer.alloc(token.length + 4);
  ready.write(token, 0, 'ascii');
  ready.writeUInt32LE(process.pid, token.length);
  control.write(ready);
});
control.on('data', command => {
  if (!requestedQuery && command.includes(0x71)) {
    requestedQuery = true;
    process.stdout.write('\x1b[6n');
  }
});
process.on('exit', () => clearTimeout(deadline));
"#;

struct ProbeReport {
    path: PathBuf,
    started: Instant,
    value: serde_json::Value,
}
impl ProbeReport {
    fn new(directory: &Path) -> Self {
        let mut report = Self {
            path: directory.join("probe.json"),
            started: Instant::now(),
            value: serde_json::json!({
                "scenario":"held_initial_cursor_query_before_single_23_byte_paste",
                "hypothesis_proven":false,
                "scenario_attempted":false,
                "cleanup_complete":false,
                "owned_child_exit_observed":null,
                "child_fixture":"installed_node_without_libtest_stdout",
                "query_source":"first_observed_CSI6n_after_child_query_release; inherit_cursor_and_child_query_are_not_distinguished",
                "milestones":[],
                "input_trace":[],
                "limits":"Native write confirmation is not provider pickup. A fixture outcome does not establish the cause of earlier original-provider failures."
            }),
        };
        report.mark("holder_started");
        report
    }
    fn persist(&self) {
        fs::write(&self.path, serde_json::to_vec(&self.value).unwrap()).unwrap();
    }
    fn mark(&mut self, name: &str) {
        let milestones = self.value["milestones"].as_array_mut().unwrap();
        milestones.push(serde_json::json!({
            "order":milestones.len()+1,
            "elapsed_us":self.started.elapsed().as_micros() as u64,
            "event":name
        }));
        self.persist();
    }
    fn trace(&mut self, event: InputTraceEvent) -> bool {
        let cursor_finished = matches!(event.kind, InputTraceKind::Unconfirmed)
            && matches!(event.phase, InputTracePhase::WriteFinished);
        let kind = match event.kind {
            InputTraceKind::Unconfirmed => "unconfirmed",
            InputTraceKind::Receipt => "receipt",
            InputTraceKind::Cleanup => "cleanup",
        };
        let phase = match event.phase {
            InputTracePhase::Queued => "queued",
            InputTracePhase::WriteStarted => "write_started",
            InputTracePhase::WriteFinished => "write_finished",
        };
        self.value["input_trace"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "sequence":event.sequence,
                "input_id":event.input_id,
                "kind":kind,
                "phase":phase,
                "bytes":event.bytes,
                "written":event.written
            }));
        self.persist();
        cursor_finished
    }
}

struct ProbeDirectory {
    path: PathBuf,
    temporary: PathBuf,
}
impl ProbeDirectory {
    fn new() -> Self {
        let temporary = fs::canonicalize(std::env::temp_dir()).unwrap();
        let path = temporary.join(format!(
            "nesvo-input-fifo-{}",
            hex::encode(nesvo_wire::random::<8>())
        ));
        fs::create_dir(&path).unwrap();
        Self { path, temporary }
    }
}
impl Drop for ProbeDirectory {
    fn drop(&mut self) {
        if let Ok(resolved) = fs::canonicalize(&self.path)
            && resolved == self.path
            && resolved.starts_with(&self.temporary)
        {
            let _ = fs::remove_dir_all(resolved);
        }
    }
}

#[derive(Default)]
struct CursorQueryGate {
    held: String,
    released: bool,
}
impl CursorQueryGate {
    async fn observe_query(&mut self, fixture: &mut FixturePty) -> bool {
        let deadline = tokio::time::Instant::now() + OBSERVATION_LIMIT;
        loop {
            let event = tokio::time::timeout_at(deadline, fixture.events.recv()).await;
            match event {
                Ok(Some(PtyEvent::Data(_, data))) => {
                    if self.held.len() + data.len() > 64 * 1024 {
                        return false;
                    }
                    self.held.push_str(&data);
                    if self.held.contains("\x1b[6n") {
                        return true;
                    }
                }
                Ok(Some(_)) | Ok(None) | Err(_) => return false,
            }
        }
    }
    fn release(&mut self, fixture: &mut FixturePty) -> usize {
        assert!(!self.released, "The cursor gate is released only once");
        self.released = true;
        fixture
            .decoder
            .feed(&std::mem::take(&mut self.held))
            .events
            .into_iter()
            .filter_map(|event| match event {
                Event::Reply(reply @ "\x1b[1;1R") => Some(reply),
                _ => None,
            })
            .map(|reply| {
                fixture.pty.send_input(reply.into()).unwrap();
                usize::from(reply == "\x1b[1;1R")
            })
            .sum()
    }
}

fn installed_node() -> PathBuf {
    let search = std::env::var_os("PATH").expect("The opt-in diagnostic needs installed Node");
    std::env::split_paths(&search)
        .map(|directory| directory.join("node.exe"))
        .find(|path| path.is_file())
        .map(|path| fs::canonicalize(path).unwrap())
        .expect("The opt-in diagnostic needs node.exe on PATH")
}

fn retain_ready_child(directory: &Path, process_id: u32) -> PinnedProcess {
    // SAFETY: the pid is the live Pty root and ready child; the handle pins it through cleanup.
    let raw = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
            0,
            process_id,
        )
    };
    assert!(!raw.is_null(), "{}", std::io::Error::last_os_error());
    let owned = unsafe { OwnedHandle::from_raw_handle(raw) };
    let record = serde_json::json!({
        "pid":process_id,
        "created":creation(owned.as_raw_handle())
    });
    let pending = directory.join("child.pending");
    fs::write(&pending, serde_json::to_vec(&record).unwrap()).unwrap();
    fs::rename(pending, directory.join("child.json")).unwrap();
    PinnedProcess(owned)
}

fn start_traced(
    command: CommandBuilder,
) -> (FixturePty, std::sync::mpsc::Receiver<InputTraceEvent>) {
    let (events, received) = tokio::sync::mpsc::channel(64);
    let (pty, trace) = Pty::spawn_traced(
        "input-fifo-probe",
        command,
        PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        },
        events,
    )
    .unwrap();
    (
        FixturePty {
            pty,
            decoder: Decoder::default(),
            events: received,
        },
        trace,
    )
}

async fn observe_input_fifo(directory: &Path, report: &mut ProbeReport) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let token = hex::encode(nesvo_wire::random::<8>());
    let script = directory.join("input-fifo-child.cjs");
    fs::write(&script, NODE_CHILD).unwrap();
    let mut command = CommandBuilder::new(installed_node());
    command.arg(&script);
    command.env_remove("NODE_OPTIONS");
    command.env(
        "NESVO_INPUT_FIFO_PORT",
        listener.local_addr().unwrap().port().to_string(),
    );
    command.env("NESVO_INPUT_FIFO_TOKEN", &token);
    let (mut fixture, trace) = start_traced(command);
    report.mark("conpty_spawned_decoder_held");
    let mut gate = CursorQueryGate::default();
    let ready = tokio::time::timeout(READY_LIMIT, async {
        let (mut control, _) = listener.accept().await.unwrap();
        let mut received = vec![0; token.len() + 4];
        control.read_exact(&mut received).await.unwrap();
        assert_eq!(
            &received[..token.len()],
            token.as_bytes(),
            "Only the owned child can signal readiness"
        );
        let process_id = u32::from_le_bytes(received[token.len()..].try_into().unwrap());
        assert_eq!(Some(process_id), fixture.pty.process_id());
        let child = retain_ready_child(directory, process_id);
        (control, child)
    })
    .await;
    let (mut control, child) = match ready {
        Ok((control, child)) => {
            report.mark("child_ready_out_of_band_decoder_still_held");
            (Some(control), Some(child))
        }
        Err(_) => {
            report.value["outcome"] = "child_readiness_not_observed_with_decoder_held".into();
            report.mark("scenario_precondition_not_observed");
            (None, None)
        }
    };
    if let Some(control) = control.as_mut() {
        report.mark("owned_child_pinned_before_explicit_query_release");
        control.write_all(b"q").await.unwrap();
        report.mark("child_explicit_query_released_after_ready");
    }
    if control.is_some() && gate.observe_query(&mut fixture).await {
        report.mark("initial_cursor_query_observed_and_held");
        report.value["scenario_attempted"] = true.into();
        assert_eq!(PASTE.len(), 23);
        let mut receipt = fixture.pty.send_confirmed(PASTE.into()).unwrap();
        report.mark("single_paste_queued_before_decoder_release");
        let deadline = Instant::now() + OBSERVATION_LIMIT;
        let mut started = false;
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            let Ok(event) = trace.recv_timeout(remaining) else {
                break;
            };
            started = matches!(event.kind, InputTraceKind::Receipt)
                && matches!(event.phase, InputTracePhase::WriteStarted);
            report.trace(event);
            if started {
                break;
            }
        }
        report.value["paste_write_started_before_release"] = started.into();
        let early = match receipt.try_recv() {
            Ok(written) => Some(if written { "confirmed" } else { "write_failed" }),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty) => None,
            Err(tokio::sync::oneshot::error::TryRecvError::Closed) => Some("receipt_closed"),
        };
        report.value["receipt_before_release"] = early.unwrap_or("pending").into();
        report.mark("decoder_gate_released");
        let replies = gate.release(&mut fixture);
        report.value["initial_cursor_replies_queued"] = replies.into();
        report.mark("decoder_replies_queued_after_paste");
        let outcome = match early {
            Some(outcome) => outcome,
            None => match tokio::time::timeout(OBSERVATION_LIMIT, &mut receipt).await {
                Ok(Ok(true)) => "confirmed",
                Ok(Ok(false)) => "write_failed",
                Ok(Err(_)) => "receipt_closed",
                Err(_) => "native_confirmation_timeout",
            },
        };
        report.value["outcome"] = outcome.into();
        report.mark("native_confirmation_observed");
        let deadline = Instant::now() + OBSERVATION_LIMIT;
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            let Ok(event) = trace.recv_timeout(remaining) else {
                break;
            };
            if report.trace(event) {
                break;
            }
        }
    } else if control.is_some() {
        report.value["outcome"] = "initial_cursor_query_not_observed".into();
        report.mark("scenario_precondition_not_observed");
    }
    for event in trace.try_iter() {
        report.trace(event);
    }
    report.mark("owned_conpty_cleanup_started");
    drop(fixture);
    for event in trace.try_iter() {
        report.trace(event);
    }
    if let Some(child) = child.as_ref() {
        let exited = wait_owned(child.0.as_raw_handle(), Duration::from_secs(5));
        report.value["owned_child_exit_observed"] = exited.into();
        if !exited {
            // SAFETY: only the creation-validated owned handle is retained and terminated.
            unsafe { TerminateProcess(child.0.as_raw_handle(), 1) };
            report.value["child_cleanup_fallback_exited"] =
                wait_owned(child.0.as_raw_handle(), Duration::from_secs(2)).into();
        }
    }
    drop(control);
    drop(child);
    report.value["cleanup_complete"] =
        (report.value["child_cleanup_fallback_exited"].as_bool() != Some(false)).into();
    report.mark("owned_conpty_cleanup_returned");
}

#[test]
#[ignore = "owned holder for the opt-in ConPTY FIFO diagnostic; watchdog required"]
fn native_input_fifo_holder_fixture() {
    let Some(directory) = std::env::var_os("NESVO_INPUT_FIFO_FIXTURE") else {
        return;
    };
    let directory = PathBuf::from(directory);
    let mut report = ProbeReport::new(&directory);
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(observe_input_fifo(&directory, &mut report));
}

fn wait_owned(handle: std::os::windows::io::RawHandle, duration: Duration) -> bool {
    // SAFETY: the retained process handle is valid for the bounded wait and no pid is looked up.
    let status = unsafe { WaitForSingleObject(handle, duration.as_millis() as u32) };
    assert!(
        status == WAIT_OBJECT_0 || status == WAIT_TIMEOUT,
        "{}",
        std::io::Error::last_os_error()
    );
    status == WAIT_OBJECT_0
}

fn pin_observed_child(directory: &Path) -> Option<PinnedProcess> {
    let record: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.join("child.json")).ok()?).ok()?;
    // SAFETY: the recorded child identity is revalidated by creation time before any use.
    let raw = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
            0,
            record["pid"].as_u64()? as u32,
        )
    };
    if raw.is_null() {
        return None;
    }
    let owned = unsafe { OwnedHandle::from_raw_handle(raw) };
    if creation(owned.as_raw_handle()) != record["created"].as_u64()? {
        return None;
    }
    Some(PinnedProcess(owned))
}

#[test]
#[ignore = "bounded native Windows diagnostic; run once explicitly with --nocapture"]
fn native_conpty_input_fifo_diagnostic() {
    let owned_directory = ProbeDirectory::new();
    let directory = &owned_directory.path;
    let mut holder = OwnedHost(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", HOLDER, "--ignored", "--nocapture"])
            .env("NESVO_INPUT_FIFO_FIXTURE", directory)
            .creation_flags(0x08000000)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let completed = wait_owned(holder.0.as_raw_handle(), Duration::from_secs(30));
    let child = pin_observed_child(directory);
    if !completed {
        holder.0.kill().unwrap();
    }
    assert!(
        wait_owned(holder.0.as_raw_handle(), Duration::from_secs(5)),
        "Owned diagnostic holder cleanup deadline"
    );
    let status = holder.0.wait().unwrap();
    let child_exited = child
        .as_ref()
        .map(|child| wait_owned(child.0.as_raw_handle(), Duration::from_secs(5)));
    let mut report = fs::read(directory.join("probe.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .unwrap_or_else(
            || serde_json::json!({"outcome":"holder_report_unavailable","hypothesis_proven":false}),
        );
    report["holder_completed_before_watchdog"] = completed.into();
    report["holder_success"] = status.success().into();
    report["observed_child_exited"] = child_exited.into();
    let child_cleanup_failed = report["child_cleanup_fallback_exited"].as_bool() == Some(false);
    eprintln!(
        "CONPTY_INPUT_FIFO_DIAGNOSTIC={}",
        serde_json::to_string(&report).unwrap()
    );
    drop(child);
    drop(holder);
    drop(owned_directory);
    assert_ne!(
        child_exited,
        Some(false),
        "Owned diagnostic child cleanup deadline"
    );
    assert!(
        !child_cleanup_failed,
        "Owned child fallback cleanup deadline"
    );
    assert!(
        completed && status.success(),
        "Diagnostic infrastructure failed; see recorded outcome"
    );
}
