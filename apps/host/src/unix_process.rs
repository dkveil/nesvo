use super::Lease;
use anyhow::Result;
use portable_pty::{Child, ChildKiller};
use std::{
    io,
    sync::{Arc, Condvar, Mutex, PoisonError},
    time::{Duration, Instant},
};

const FIRST_RECHECK: Duration = Duration::from_millis(1);
const LAST_RECHECK: Duration = Duration::from_millis(50);

#[derive(Debug)]
pub struct Native(libc::pid_t);

impl Native {
    pub(super) fn release(&self) {}

    pub(super) fn idle(&self) -> io::Result<bool> {
        // SAFETY: signal zero performs only the permission and existence check for this group.
        if unsafe { libc::kill(-self.0, 0) } == 0 {
            return Ok(false);
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ESRCH) => Ok(true),
            Some(libc::EPERM) => Ok(false),
            _ => Err(error),
        }
    }

    pub(super) fn watch(&self) -> io::Result<Watch> {
        Ok(Watch {
            recheck: FIRST_RECHECK,
            pause: (Mutex::new(()), Condvar::new()),
        })
    }
}

pub struct Watch {
    recheck: Duration,
    pause: (Mutex<()>, Condvar),
}

impl Watch {
    pub(super) fn next(&mut self, _group: &Native, deadline: Instant) -> io::Result<()> {
        let wait = self
            .recheck
            .min(deadline.saturating_duration_since(Instant::now()));
        let guard = self.pause.0.lock().unwrap_or_else(PoisonError::into_inner);
        drop(
            self.pause
                .1
                .wait_timeout(guard, wait)
                .unwrap_or_else(PoisonError::into_inner),
        );
        self.recheck = (self.recheck * 2).min(LAST_RECHECK);
        Ok(())
    }
}

#[derive(Debug)]
struct UnixKiller {
    root: Box<dyn ChildKiller + Send + Sync>,
    lease: Arc<Lease>,
}

impl ChildKiller for UnixKiller {
    fn kill(&mut self) -> io::Result<()> {
        self.root.kill()
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(Self {
            root: self.root.clone_killer(),
            lease: Arc::clone(&self.lease),
        })
    }
}

pub fn killer(name: &str, child: &dyn Child) -> Result<Box<dyn ChildKiller + Send + Sync>> {
    let root = child.clone_killer();
    let group = child
        .process_id()
        .and_then(|id| libc::pid_t::try_from(id).ok())
        .filter(|group| *group > 1);
    Ok(match group {
        Some(group) => Box::new(UnixKiller {
            root,
            lease: super::SESSION_JOBS.lease(name, Native(group)),
        }),
        None => root,
    })
}

#[cfg(test)]
pub(super) fn enrolled(child: &std::process::Child) -> Native {
    Native(libc::pid_t::try_from(child.id()).unwrap())
}
