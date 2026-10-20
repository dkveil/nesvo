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
        #[cfg(all(unix, not(target_os = "macos")))]
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
        #[cfg(target_os = "macos")]
        {
            macos_group_terminated(self.group)
        }
        #[cfg(windows)]
        {
            Ok(crate::process::command_job_empty(&self.job)?)
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_group_terminated(group: i32) -> Result<bool> {
    // Darwin counts unreaped zombies as successful kill(..., 0) targets. Read
    // bounded group membership and process states instead; never signal them.
    let mut pids = vec![0i32; 4096];
    // SAFETY: __error is this thread's errno; the initialized PID array has the
    // exact byte capacity passed to libproc. No await or shared errno access.
    let count = unsafe {
        *libc::__error() = 0;
        libc::proc_listpgrppids(
            group,
            pids.as_mut_ptr().cast(),
            std::mem::size_of_val(pids.as_slice()) as i32,
        )
    };
    if count <= 0 {
        let error = std::io::Error::last_os_error();
        anyhow::ensure!(
            count == 0 && error.raw_os_error() == Some(0),
            "Group membership observation failed: {error}"
        );
        return Ok(true);
    }
    let count = usize::try_from(count)?;
    anyhow::ensure!(
        count < pids.len(),
        "Group membership exceeds observation bound"
    );
    for pid in pids.into_iter().take(count) {
        anyhow::ensure!(pid > 0, "Invalid observed process identity");
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        // SAFETY: this flavor writes a proc_bsdinfo, with the exact output size.
        // arg=1 includes zombie records. Only full successful writes are read.
        let read = unsafe {
            *libc::__error() = 0;
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                1,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        if read != size {
            let error = std::io::Error::last_os_error();
            if read == 0 && error.raw_os_error() == Some(libc::ESRCH) {
                continue;
            }
            anyhow::bail!("Process state observation failed: {error}");
        }
        // SAFETY: libproc confirmed the exact initialized structure size.
        let info = unsafe { info.assume_init() };
        anyhow::ensure!(info.pbi_pid == pid as u32, "Process state identity changed");
        if info.pbi_status != libc::SZOMB {
            // A reused/moved identity is conservative uncertainty too; repeat
            // the membership query on the next observation, never send a signal.
            return Ok(false);
        }
    }
    Ok(true)
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

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn an_unreaped_zombie_has_terminated_without_requiring_a_signal() -> Result<()> {
        let mut command = Command::new("/usr/bin/true");
        configure(&mut command);
        let mut child = command.spawn()?;
        let scope = Scope::enroll(&child)?;
        let observed = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !scope.empty()? {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await;
        // Child is still unreaped: termination identity cannot have been reused.
        let _ = scope.terminate();
        child.wait().await?;
        observed.context("Observe terminated zombie before parent wait")??;
        Ok(())
    }
}
