//! One live host owns a data directory. A stale file is not a stale OS lock.
//!
//! Unix `flock` ownership is shared by duplicated/forked descriptors. Explicit
//! unlock ends this guard's ownership even while another descriptor remains open;
//! close-on-exec alone does not cover the interval between fork and exec.
//! See [Apple's flock(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html)
//! and [Linux flock(2)](https://man7.org/linux/man-pages/man2/flock.2.html).
use anyhow::{Context, Result};
use std::{
    fs::{File, OpenOptions},
    io,
    path::Path,
};

pub struct HostLock {
    _file: File,
}
impl HostLock {
    pub fn acquire(directory: &Path) -> Result<Self> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(directory.join("host.lock"))
            .context("Cannot open host data-directory lock")?;
        try_lock(&file).map_err(|error| {
            if error.kind()==io::ErrorKind::WouldBlock {
                anyhow::anyhow!("Another nesvo-host already owns this pairing/data directory. Reuse it or choose a separate --pairing-dir; do not delete host.lock to bypass a live owner.")
            } else {anyhow::Error::new(error).context("Cannot exclusively lock host data directory")}
        })?;
        // Never unlink: another process could otherwise lock a different inode.
        // Rust opens Unix files close-on-exec and Windows handles non-inheritable.
        // A Unix fork can still retain the shared lock until exec; Drop unlocks it.
        Ok(Self { _file: file })
    }
}
#[cfg(unix)]
impl Drop for HostLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        // SAFETY: this guard still owns a live file descriptor. LOCK_UN releases
        // its shared open-file-description lock without waiting for another host.
        // The File closes normally afterwards, including if unlock reports error.
        let _ = unsafe { libc::flock(self._file.as_raw_fd(), libc::LOCK_UN) };
    }
}
#[cfg(unix)]
fn try_lock(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: this live File owns the descriptor. flock takes no pointers and
    // LOCK_NB never waits for a different host to release its lock.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
#[cfg(windows)]
fn try_lock(file: &File) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{
        Foundation::ERROR_LOCK_VIOLATION,
        Storage::FileSystem::{LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx},
        System::IO::OVERLAPPED,
    };
    // SAFETY: zeroed OVERLAPPED specifies offset zero and no event handle. The
    // file is synchronous; FAIL_IMMEDIATELY prevents a pending lock operation.
    let mut overlap: OVERLAPPED = unsafe { std::mem::zeroed() };
    // SAFETY: File owns a valid, non-inheritable, read/write handle for the call.
    let result = unsafe {
        LockFileEx(
            file.as_raw_handle().cast(),
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            1,
            0,
            &mut overlap,
        )
    };
    if result != 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_LOCK_VIOLATION as i32) {
        Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "Host lock is owned",
        ))
    } else {
        Err(error)
    }
}
#[cfg(not(any(windows, unix)))]
fn try_lock(_file: &File) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Native host locking is unavailable on this platform",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "nesvo-host-lock-{}",
                hex::encode(crate::wire::random::<8>())
            ));
            std::fs::create_dir(&directory).unwrap();
            Self(directory)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            // This private fixture is declared before its handles, so their
            // guards close first even when an assertion unwinds the test.
            let _ = std::fs::remove_file(self.0.join("host.lock"));
            let _ = std::fs::remove_dir(&self.0);
        }
    }

    #[test]
    fn live_owner_excludes_other_handles_but_existing_file_does_not_prevent_restart() {
        let directory = Directory::new();
        let first = HostLock::acquire(&directory.0).unwrap();
        assert!(HostLock::acquire(&directory.0).is_err());
        drop(first);
        assert!(directory.0.join("host.lock").exists());
        let next = HostLock::acquire(&directory.0).unwrap();
        drop(next);
    }

    #[cfg(unix)]
    #[test]
    fn dropping_owner_unlocks_a_retained_description_without_releasing_its_successor() {
        let directory = Directory::new();
        let first = HostLock::acquire(&directory.0).unwrap();
        // Deterministically retain the same open file description as dup/fork.
        // This tests that lifetime directly, not a particular child scheduler.
        let retained = first._file.try_clone().unwrap();
        assert!(HostLock::acquire(&directory.0).is_err());
        drop(first);
        assert!(retained.metadata().is_ok());
        assert!(directory.0.join("host.lock").exists());

        let successor = HostLock::acquire(&directory.0).unwrap();
        assert!(HostLock::acquire(&directory.0).is_err());
        drop(retained);
        assert!(
            HostLock::acquire(&directory.0).is_err(),
            "Closing an old unlocked description must not release a new owner's lock"
        );
        drop(successor);
        drop(HostLock::acquire(&directory.0).unwrap());
    }
}
