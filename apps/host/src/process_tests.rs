#[cfg(not(windows))]
use super::unix::enrolled;
#[cfg(windows)]
use super::windows::enrolled;
use super::{Cause, Ledger};
use std::{
    io::Read,
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

const FIXTURE: &str = "process::tests::held_descendant_fixture";
const SETTLEMENT_BOUND: Duration = Duration::from_secs(10);

#[test]
#[ignore = "owned descendant held by its stdin; launched explicitly by the session job settlement tests"]
fn held_descendant_fixture() {
    if std::env::var_os("NESVO_HELD_DESCENDANT").is_none() {
        return;
    }
    let mut released = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut released);
}

struct Held(Child);

impl Held {
    fn spawn() -> Self {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", FIXTURE, "--ignored", "--nocapture"])
            .env("NESVO_HELD_DESCENDANT", "owned")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        Self(command.spawn().unwrap())
    }

    fn release(&mut self) {
        drop(self.0.stdin.take());
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        self.release();
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

#[test]
fn settlement_returns_only_after_the_console_release_and_the_last_job_process() {
    let ledger = Ledger::new();
    let mut fixture = Held::spawn();
    let lease = ledger.lease("fixture-session", enrolled(&fixture.0));
    let (settled_tx, settled) = mpsc::channel();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            settled_tx
                .send(ledger.settle(Instant::now() + SETTLEMENT_BOUND))
                .unwrap();
        });
        assert!(
            settled.try_recv().is_err(),
            "An unreleased console host keeps the session job unsettled"
        );
        drop(lease);
        #[cfg(unix)]
        {
            assert!(
                settled.try_recv().is_err(),
                "A live process group member keeps the session job unsettled"
            );
            fixture.release();
            fixture.0.wait().unwrap();
        }
        let unsettled = settled.recv().unwrap();
        assert!(unsettled.is_empty(), "{unsettled:?}");
        assert!(
            fixture.0.try_wait().unwrap().is_some(),
            "Settlement returned before the owned descendant exited"
        );
    });
    assert!(
        ledger.settle(Instant::now()).is_empty(),
        "A settled job leaves nothing to report"
    );
}

#[test]
fn settlement_guard_names_the_job_whose_console_or_descendant_refuses_to_end() {
    let ledger = Ledger::new();
    let fixture = Held::spawn();
    let lease = ledger.lease("held-session", enrolled(&fixture.0));
    let unsettled = ledger.settle(Instant::now());
    assert_eq!(unsettled.len(), 1);
    assert_eq!(unsettled[0].job, "held-session");
    assert!(matches!(unsettled[0].cause, Cause::Console));
    assert_eq!(
        unsettled[0].to_string(),
        "Session job held-session did not release its console host within the shutdown bound"
    );
    drop(lease);
    #[cfg(unix)]
    {
        let unsettled = ledger.settle(Instant::now());
        assert_eq!(unsettled.len(), 1);
        assert!(matches!(unsettled[0].cause, Cause::Processes));
        assert_eq!(
            unsettled[0].to_string(),
            "Session job held-session still had active processes at the shutdown bound"
        );
    }
    drop(fixture);
    assert!(ledger.settle(Instant::now() + SETTLEMENT_BOUND).is_empty());
}
