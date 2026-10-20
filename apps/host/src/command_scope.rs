//! A waiting helper is contained before any configured command may execute.
use anyhow::{Context, Result};
use tokio::process::{Child, Command};

pub struct Scope {
    #[cfg(unix)]
    group: i32,
    #[cfg(windows)]
    job: std::os::windows::io::OwnedHandle,
}
pub fn configure(command: &mut Command) {
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
}
#[cfg(windows)]
pub fn system_root() -> Result<std::ffi::OsString> {
    use std::os::windows::ffi::OsStringExt;
    let mut buffer = vec![0u16; 32768];
    // SAFETY: initialized UTF16 output with its exact capacity. Query the OS,
    // not an ambient environment value potentially changed by the caller.
    let length = unsafe {
        windows_sys::Win32::System::SystemInformation::GetWindowsDirectoryW(
            buffer.as_mut_ptr(),
            buffer.len() as u32,
        )
    } as usize;
    anyhow::ensure!(
        length > 0 && length < buffer.len(),
        "Windows system directory unavailable"
    );
    Ok(std::ffi::OsString::from_wide(&buffer[..length]))
}
impl Scope {
    pub fn enroll(child: &Child) -> Result<Self> {
        #[cfg(unix)]
        {
            let group = i32::try_from(child.id().context("Missing helper identity")?)?;
            anyhow::ensure!(group > 1, "Invalid helper process group");
            Ok(Self { group })
        }
        #[cfg(windows)]
        {
            Ok(Self {
                job: crate::process::command_job(child)?,
            })
        }
    }
    pub fn terminate(&self) -> Result<()> {
        #[cfg(unix)]
        {
            // SAFETY: this group was created for the exact helper. The parent
            // retains Child without polling/reaping it until after this signal,
            // so its leader identity cannot be recycled before termination.
            if unsafe { libc::kill(-self.group, libc::SIGKILL) } == 0 {
                return Ok(());
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(())
            } else {
                Err(error.into())
            }
        }
        #[cfg(windows)]
        {
            crate::process::terminate_command_job(&self.job)
                .context("Terminate precheck process job")
        }
    }
    pub fn empty(&self) -> Result<bool> {
        #[cfg(unix)]
        {
            // SAFETY: signal zero only observes existence/permission. This may be used
            // after reaping the leader: a recycled numeric group can at worst
            // retain capacity conservatively, never receive a terminating signal.
            if unsafe { libc::kill(-self.group, 0) } == 0 {
                return Ok(false);
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(true)
            } else {
                Err(error.into())
            }
        }
        #[cfg(windows)]
        {
            Ok(crate::process::command_job_empty(&self.job)?)
        }
    }
}
// The adapter retires termination ownership before/when it reaps the leader.
// A retained observer may query signal zero, never terminate a recycled group.

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_live_group_is_not_assumed_empty() {
        // SAFETY: queries the test process's group; empty uses signal zero only.
        let group = unsafe { libc::getpgrp() };
        let observer = Scope { group };
        assert!(!observer.empty().unwrap());
    }
}
