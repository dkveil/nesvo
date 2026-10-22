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
        Ok(Self { _file: file })
    }
}
#[cfg(unix)]
impl Drop for HostLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        // SAFETY: the guard owns a live descriptor and LOCK_UN never waits; the File closes after.
        let _ = unsafe { libc::flock(self._file.as_raw_fd(), libc::LOCK_UN) };
    }
}
#[cfg(unix)]
fn try_lock(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: the live File owns the descriptor, flock takes no pointers and LOCK_NB never waits.
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
    // SAFETY: zeroed OVERLAPPED is offset zero, no event; FAIL_IMMEDIATELY leaves nothing pending.
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
