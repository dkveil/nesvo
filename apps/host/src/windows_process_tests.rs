use crate::{
    pty::{Pty, PtyEvent},
    terminal_protocol::{Decoder, Event},
};
use portable_pty::{CommandBuilder, PtySize};
use std::{
    fs,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{FILETIME, INVALID_HANDLE_VALUE, WAIT_OBJECT_0},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
        LibraryLoader::GetModuleHandleW,
        Threading::{
            DETACHED_PROCESS, GetCurrentProcess, GetExitCodeProcess, GetProcessTimes, OpenProcess,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
            TerminateProcess, WaitForMultipleObjects, WaitForSingleObject,
        },
    },
};

const HELPER: &str = "process::windows::tests::native_tree_fixture";
const CONSOLE_FIXTURE: &str = "process::windows::tests::native_console_fixture";
const CLEANUP_BOUND: Duration = Duration::from_secs(5);

struct ConsoleHost {
    name: String,
    handle: OwnedHandle,
}
impl ConsoleHost {
    fn ended_within(&self, bound: Duration) -> bool {
        // SAFETY: the pinned synchronize handle stays valid for this bounded wait.
        let signaled =
            unsafe { WaitForSingleObject(self.handle.as_raw_handle(), bound.as_millis() as u32) };
        signaled == WAIT_OBJECT_0
    }
}

fn console_hosts(parent: &std::process::Child) -> Vec<ConsoleHost> {
    let parent_created = creation(parent.as_raw_handle());
    // SAFETY: a process snapshot takes only the documented flag and no process identity.
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    assert_ne!(
        raw,
        INVALID_HANDLE_VALUE,
        "{}",
        std::io::Error::last_os_error()
    );
    // SAFETY: a successful snapshot returns an independently owned handle.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut hosts = Vec::new();
    // SAFETY: the entry carries its exact size and the owned snapshot outlives the walk.
    let mut listed = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) } != 0;
    while listed {
        let length = entry.szExeFile.iter().position(|unit| *unit == 0);
        let name = String::from_utf16_lossy(&entry.szExeFile[..length.unwrap_or(260)]);
        if entry.th32ParentProcessID == parent.id()
            && ["conhost.exe", "openconsole.exe"].contains(&name.to_ascii_lowercase().as_str())
        {
            // SAFETY: opens a listed child; its creation time below rules out a reused parent id.
            let raw = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    entry.th32ProcessID,
                )
            };
            if !raw.is_null() {
                // SAFETY: a successful OpenProcess returns an independently owned handle.
                let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
                if creation(handle.as_raw_handle()) >= parent_created {
                    hosts.push(ConsoleHost { name, handle });
                }
            }
        }
        // SAFETY: same initialized entry and owned snapshot as the first call.
        listed = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) } != 0;
    }
    hosts
}

fn first_ended(hosts: &[ConsoleHost]) -> usize {
    let handles: Vec<_> = hosts
        .iter()
        .map(|host| host.handle.as_raw_handle())
        .collect();
    // SAFETY: every pinned synchronize handle outlives this bounded wait.
    let signaled = unsafe {
        WaitForMultipleObjects(
            handles.len() as u32,
            handles.as_ptr(),
            0,
            CLEANUP_BOUND.as_millis() as u32,
        )
    };
    let index = signaled.wrapping_sub(WAIT_OBJECT_0) as usize;
    assert!(
        index < handles.len(),
        "No console host ended within {CLEANUP_BOUND:?}"
    );
    index
}

fn creation(handle: std::os::windows::io::RawHandle) -> u64 {
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: borrowed live handle and initialized output structures.
    assert_ne!(
        unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) },
        0,
        "{}",
        std::io::Error::last_os_error()
    );
    ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64
}

#[test]
#[ignore = "owned subprocess helper; launched explicitly by the ConPTY ownership test"]
#[allow(
    clippy::zombie_processes,
    reason = "The fixture intentionally leaves live descendants for the job ownership test to terminate and observe"
)]
fn native_tree_fixture() {
    let Some(directory) = std::env::var_os("NESVO_PROCESS_FIXTURE") else {
        return;
    };
    let directory = PathBuf::from(directory);
    let role = std::env::var("NESVO_PROCESS_FIXTURE_ROLE").unwrap();
    let next = match role.as_str() {
        "root" => Some("child"),
        "child" => Some("grandchild"),
        _ => None,
    };
    if let Some(next) = next {
        let _descendant = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", HELPER, "--ignored", "--nocapture"])
            .env("NESVO_PROCESS_FIXTURE_ROLE", next)
            .spawn()
            .unwrap();
    }
    let record = serde_json::json!({
        "pid":std::process::id(),
        // SAFETY: the current-process pseudo handle is valid for this call.
        "created":creation(unsafe { GetCurrentProcess() })
    });
    let pending = directory.join(format!("{role}.pending"));
    fs::write(&pending, serde_json::to_vec(&record).unwrap()).unwrap();
    fs::rename(pending, directory.join(format!("{role}.json"))).unwrap();
    while !directory.join(format!("exit-{role}")).exists() {
        std::thread::sleep(Duration::from_millis(20));
    }
}

struct PinnedProcess(OwnedHandle);
impl PinnedProcess {
    fn read(directory: &Path, role: &str) -> Self {
        let record: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.join(format!("{role}.json"))).unwrap())
                .unwrap();
        // SAFETY: opens only the pid this owned fixture reported and checks its creation time.
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
                0,
                record["pid"].as_u64().unwrap() as u32,
            )
        };
        assert!(!raw.is_null(), "{}", std::io::Error::last_os_error());
        let owned = unsafe { OwnedHandle::from_raw_handle(raw) };
        assert_eq!(creation(owned.as_raw_handle()), record["created"]);
        Self(owned)
    }
    fn running(&self) -> bool {
        let mut status = 0;
        // SAFETY: this exact process handle remains pinned independently of PID.
        assert_ne!(
            unsafe { GetExitCodeProcess(self.0.as_raw_handle(), &mut status) },
            0
        );
        status == 259
    }
}
impl Drop for PinnedProcess {
    fn drop(&mut self) {
        if self.running() {
            unsafe { TerminateProcess(self.0.as_raw_handle(), 1) };
        }
    }
}

struct FixturePty {
    pty: Pty,
    decoder: Decoder,
    events: tokio::sync::mpsc::Receiver<PtyEvent>,
}
impl FixturePty {
    fn start(directory: &Path, role: &str) -> Self {
        let mut command = CommandBuilder::new(std::env::current_exe().unwrap());
        command.args(["--exact", HELPER, "--ignored", "--nocapture"]);
        command.env("NESVO_PROCESS_FIXTURE", directory);
        command.env("NESVO_PROCESS_FIXTURE_ROLE", role);
        let (events, received) = tokio::sync::mpsc::channel(64);
        Self {
            pty: Pty::spawn(
                role,
                command,
                PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                events,
            )
            .unwrap(),
            decoder: Decoder::default(),
            events: received,
        }
    }
    async fn ready(&mut self, directory: &Path, roles: &[&str]) -> Vec<PinnedProcess> {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !roles
            .iter()
            .all(|role| directory.join(format!("{role}.json")).exists())
        {
            assert!(
                Instant::now() < deadline,
                "Native process-tree fixture startup deadline"
            );
            while let Ok(event) = self.events.try_recv() {
                if let PtyEvent::Data(_, data) = event {
                    for event in self.decoder.feed(&data).events {
                        if let Event::Reply(reply) = event {
                            self.pty.send_input(reply.into()).unwrap();
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        roles
            .iter()
            .map(|role| PinnedProcess::read(directory, role))
            .collect()
    }
}

#[path = "windows_input_fifo_probe_tests.rs"]
mod input_fifo_probe;
impl Drop for FixturePty {
    fn drop(&mut self) {
        let _ = self
            .pty
            .prepare_termination(self.decoder.initial_cursor_reply_needed());
        let _ = self.pty.kill();
    }
}

#[test]
#[ignore = "owned subprocess holding a PTY job; terminated by the host-death test"]
fn native_host_fixture() {
    let Some(directory) = std::env::var_os("NESVO_PROCESS_FIXTURE") else {
        return;
    };
    let directory = PathBuf::from(directory);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    runtime.block_on(async {
        let mut tree = FixturePty::start(&directory, "root");
        let _unanswered_startup_query = FixturePty::start(&directory, "unanswered");
        let _processes = tree
            .ready(&directory, &["root", "child", "grandchild"])
            .await;
        fs::write(directory.join("holder-ready"), b"native job held").unwrap();
        std::future::pending::<()>().await;
    });
}

struct OwnedHost(std::process::Child);
impl Drop for OwnedHost {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test]
async fn abrupt_owned_host_death_closes_noninherited_jobs_and_reaps_observed_descendants() {
    use std::os::windows::process::CommandExt;
    let directory = std::env::temp_dir().join(format!(
        "nesvo-owned-host-death-{}",
        hex::encode(nesvo_wire::random::<8>())
    ));
    fs::create_dir(&directory).unwrap();
    let mut host = OwnedHost(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "process::windows::tests::native_host_fixture",
                "--ignored",
            ])
            .env("NESVO_PROCESS_FIXTURE", &directory)
            .creation_flags(DETACHED_PROCESS)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while !directory.join("holder-ready").exists() {
        assert!(
            host.0.try_wait().unwrap().is_none(),
            "Owned native holder exited early"
        );
        assert!(
            Instant::now() < deadline,
            "Owned native holder readiness deadline"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let processes =
        ["root", "child", "grandchild"].map(|role| PinnedProcess::read(&directory, role));
    let consoles = console_hosts(&host.0);
    assert_eq!(
        consoles
            .iter()
            .map(|host| host.name.to_ascii_lowercase())
            .collect::<Vec<_>>(),
        ["conhost.exe", "conhost.exe"],
        "Both pseudo consoles, including one whose startup query was never answered, use the system host"
    );
    host.0.kill().unwrap();
    host.0.wait().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while processes.iter().any(PinnedProcess::running) {
        assert!(
            Instant::now() < deadline,
            "A job member survived its owned host's death"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        consoles
            .iter()
            .all(|console| console.ended_within(CLEANUP_BOUND)),
        "A console host survived its owned host's death"
    );
    drop(host);
    drop(processes);
    fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn stopping_or_exiting_one_pty_reaps_its_descendants_and_preserves_another_session() {
    for natural in [false, true] {
        let directory = std::env::temp_dir().join(format!(
            "nesvo-owned-tree-{}",
            hex::encode(nesvo_wire::random::<8>())
        ));
        fs::create_dir(&directory).unwrap();
        let mut tree = FixturePty::start(&directory, "root");
        let processes = tree
            .ready(&directory, &["root", "child", "grandchild"])
            .await;
        let mut sibling = FixturePty::start(&directory, "sibling");
        let independent = sibling.ready(&directory, &["sibling"]).await;
        assert!(processes.iter().all(PinnedProcess::running));
        if natural {
            fs::write(directory.join("exit-root"), b"owner fixture release").unwrap();
        } else {
            tree.pty.kill().unwrap();
            tree.pty.kill().unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while processes.iter().any(PinnedProcess::running) {
            assert!(
                Instant::now() < deadline,
                "Owned descendant survived (natural={natural})"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            independent[0].running(),
            "Another session must retain its process"
        );
        drop(tree);
        sibling.pty.kill().unwrap();
        drop(sibling);
        drop(processes);
        drop(independent);
        fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
#[ignore = "owned host-state subprocess; driven by the console host ownership test"]
fn native_console_fixture() {
    if std::env::var_os("NESVO_CONSOLE_FIXTURE").is_none() {
        return;
    }
    let mut state = crate::sessions::State::new(
        std::env::temp_dir().canonicalize().unwrap(),
        crate::storage::MetadataStore::open(Path::new(":memory:")).unwrap(),
        crate::launchers::Launchers::discover_with_fixture_shell(),
    );
    let (events, _output) = tokio::sync::mpsc::channel(128);
    let mut launch = |name: &str| {
        let spec = crate::jobs::LaunchSpec {
            name: name.into(),
            ..Default::default()
        };
        state.launch(&spec, &events).unwrap()
    };
    let stopped = launch("Stopped console fixture");
    launch("Dropped console fixture");
    let module: Vec<u16> = "conpty.dll\0".encode_utf16().collect();
    // SAFETY: a NUL-terminated module name; the call only inspects already loaded modules.
    let sideloaded = unsafe { GetModuleHandleW(module.as_ptr()) };
    assert!(
        sideloaded.is_null(),
        "ConPTY must be the system implementation, never a conpty.dll found on PATH"
    );
    let mut commands = std::io::stdin().lines();
    let mut stage = |reached: &str, next: &str| {
        println!("console-fixture {reached}");
        assert_eq!(commands.next().unwrap().unwrap(), next);
    };
    stage("launched", "stop");
    state
        .dispatch_control(
            &stopped,
            crate::operations::ControlAction::Stop,
            &crate::caller::Authority::Owner,
        )
        .unwrap();
    println!("console-fixture stopped");
    if commands.next().unwrap().unwrap() == "shutdown" {
        for worker in state.shutdown() {
            worker.join().unwrap();
        }
        let unsettled = crate::process::SESSION_JOBS.settle(Instant::now() + CLEANUP_BOUND);
        println!("console-fixture settled {}", unsettled.len());
    }
    drop(state);
    println!("console-fixture dropped");
}

fn console_hosts_end_after(finish: &str, reported: Option<&str>, ended: &str) {
    use std::{
        io::{BufRead, Write},
        os::windows::process::CommandExt,
    };
    let mut fixture = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", CONSOLE_FIXTURE, "--ignored", "--nocapture"])
        .env("NESVO_CONSOLE_FIXTURE", "owned")
        .creation_flags(DETACHED_PROCESS)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut commands = fixture.stdin.take().unwrap();
    let mut stages = std::io::BufReader::new(fixture.stdout.take().unwrap())
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| line.strip_prefix("console-fixture ").map(str::to_owned));
    assert_eq!(stages.next().as_deref(), Some("launched"));
    let consoles = console_hosts(&fixture);
    assert_eq!(
        consoles
            .iter()
            .map(|console| console.name.to_ascii_lowercase())
            .collect::<Vec<_>>(),
        ["conhost.exe", "conhost.exe"],
        "Each session owns exactly one system console host"
    );
    writeln!(commands, "stop").unwrap();
    assert_eq!(stages.next().as_deref(), Some("stopped"));
    let remaining = &consoles[1 - first_ended(&consoles)];
    assert!(
        !remaining.ended_within(Duration::ZERO),
        "Stopping one session must keep the other session's console host"
    );
    writeln!(commands, "{finish}").unwrap();
    if let Some(reported) = reported {
        assert_eq!(stages.next().as_deref(), Some(reported));
    }
    assert_eq!(stages.next().as_deref(), Some("dropped"));
    assert!(remaining.ended_within(CLEANUP_BOUND), "{ended}");
    assert!(fixture.wait().unwrap().success());
}

#[test]
fn console_hosts_end_with_their_stopped_session_and_with_the_dropped_host_state() {
    console_hosts_end_after(
        "drop",
        None,
        "Dropping the host state must end the remaining console host",
    );
}

#[test]
fn graceful_state_shutdown_settles_every_session_job_and_ends_console_hosts() {
    console_hosts_end_after(
        "shutdown",
        Some("settled 0"),
        "Graceful shutdown must end the remaining console host",
    );
}
