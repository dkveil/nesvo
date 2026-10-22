use std::{
    sync::{Arc, Condvar, Mutex, PoisonError},
    time::Instant,
};

#[cfg(not(windows))]
#[path = "unix_process.rs"]
mod unix;
#[cfg(not(windows))]
use unix::Native;
#[cfg(not(windows))]
pub use unix::killer;

#[cfg(windows)]
#[path = "windows_process.rs"]
mod windows;
#[cfg(windows)]
use windows::Native;
#[cfg(windows)]
pub use windows::killer;
#[cfg(windows)]
pub use windows::{command_job, command_job_empty, system_conpty, terminate_command_job};

pub static SESSION_JOBS: Ledger = Ledger::new();

#[derive(Debug)]
struct SessionJob {
    name: String,
    native: Native,
    released: Mutex<bool>,
    changed: Condvar,
}

impl SessionJob {
    fn settled(&self) -> bool {
        *self.released.lock().unwrap_or_else(PoisonError::into_inner)
            && matches!(self.native.idle(), Ok(true))
    }

    fn settle(&self, deadline: Instant) -> Result<(), Cause> {
        let released = self.released.lock().unwrap_or_else(PoisonError::into_inner);
        let (released, _) = self
            .changed
            .wait_timeout_while(
                released,
                deadline.saturating_duration_since(Instant::now()),
                |released| !*released,
            )
            .unwrap_or_else(PoisonError::into_inner);
        if !*released {
            return Err(Cause::Console);
        }
        drop(released);
        let mut watch = self.native.watch().map_err(Cause::Accounting)?;
        loop {
            if self.native.idle().map_err(Cause::Accounting)? {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(Cause::Processes);
            }
            watch
                .next(&self.native, deadline)
                .map_err(Cause::Accounting)?;
        }
    }
}

#[derive(Debug)]
pub struct Lease(Arc<SessionJob>);

#[cfg(windows)]
impl Lease {
    fn native(&self) -> &Native {
        &self.0.native
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.0.native.release();
        *self
            .0
            .released
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = true;
        self.0.changed.notify_all();
    }
}

#[derive(Debug)]
pub enum Cause {
    Console,
    Processes,
    Accounting(std::io::Error),
}

#[derive(Debug)]
pub struct Unsettled {
    pub job: String,
    pub cause: Cause,
}

impl std::fmt::Display for Unsettled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let job = &self.job;
        match &self.cause {
            Cause::Console => write!(
                f,
                "Session job {job} did not release its console host within the shutdown bound"
            ),
            Cause::Processes => write!(
                f,
                "Session job {job} still had active processes at the shutdown bound"
            ),
            Cause::Accounting(error) => {
                write!(f, "Session job {job} process accounting failed: {error}")
            }
        }
    }
}

#[derive(Debug)]
pub struct Ledger(Mutex<Vec<Arc<SessionJob>>>);

impl Ledger {
    const fn new() -> Self {
        Self(Mutex::new(Vec::new()))
    }

    fn lease(&self, name: &str, native: Native) -> Arc<Lease> {
        let job = Arc::new(SessionJob {
            name: name.to_owned(),
            native,
            released: Mutex::new(false),
            changed: Condvar::new(),
        });
        let mut jobs = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        jobs.retain(|job| !job.settled());
        jobs.push(Arc::clone(&job));
        Arc::new(Lease(job))
    }

    pub fn settle(&self, deadline: Instant) -> Vec<Unsettled> {
        let jobs = self
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let unsettled = jobs
            .iter()
            .filter_map(|job| {
                job.settle(deadline).err().map(|cause| Unsettled {
                    job: job.name.clone(),
                    cause,
                })
            })
            .collect();
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|job| !job.settled());
        unsettled
    }
}

pub fn display_path(path: &std::path::Path) -> String {
    let value = path.display().to_string();
    #[cfg(windows)]
    {
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        if let Some(local) = value.strip_prefix(r"\\?\") {
            return local.to_owned();
        }
    }
    value
}

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;
