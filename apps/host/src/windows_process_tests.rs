//! Native Rust fixtures and real ConPTYs; no shell, Node or model dependency.
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
    Foundation::FILETIME,
    System::Threading::{
        GetCurrentProcess, GetExitCodeProcess, GetProcessTimes, OpenProcess,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, TerminateProcess,
    },
};

const HELPER: &str = "process::windows::tests::native_tree_fixture";

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
        // Intentionally leave the descendant alive when this helper exits.
        // The process job, not a cooperative child Drop, must contain it.
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
        // SAFETY: open only the identity reported by this owned fixture. The
        // creation timestamp is checked before observation or cleanup by handle.
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
        // Failure cleanup uses only a creation-validated, retained owned handle.
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
            .creation_flags(0x08000000)
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
    // std::process::Child retains this exact created host handle, not a PID kill.
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
            tree.pty.kill().unwrap(); // Original stop replay/natural-exit race is harmless.
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
