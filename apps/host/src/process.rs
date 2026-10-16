use anyhow::Result;
use portable_pty::{Child, ChildKiller};

#[cfg(not(windows))]
pub fn killer(child: &dyn Child) -> Result<Box<dyn ChildKiller + Send + Sync>> {
    Ok(child.clone_killer())
}

// portable-pty 0.9.0's WinChildKiller reverses the TerminateProcess success
// condition. Own a duplicate of this exact child handle and check the Windows
// return value correctly; never terminate a process by a reusable PID.
#[cfg(windows)]
pub fn killer(child: &dyn Child) -> Result<Box<dyn ChildKiller + Send + Sync>> {
    use std::os::windows::io::{BorrowedHandle, OwnedHandle};
    #[derive(Debug)]
    struct WindowsKiller(OwnedHandle);
    impl ChildKiller for WindowsKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            use std::os::windows::io::AsRawHandle;
            // SAFETY: self owns a valid duplicated process handle for this child.
            let result = unsafe {
                windows_sys::Win32::System::Threading::TerminateProcess(self.0.as_raw_handle(), 1)
            };
            if result != 0 {
                return Ok(());
            }
            let error = std::io::Error::last_os_error();
            let mut status = 0;
            // A natural exit may race with the user's Close action.
            let queried = unsafe {
                windows_sys::Win32::System::Threading::GetExitCodeProcess(
                    self.0.as_raw_handle(),
                    &mut status,
                )
            };
            if queried != 0 && status != 259 {
                Ok(())
            } else {
                Err(error)
            }
        }
        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(WindowsKiller(
                self.0
                    .try_clone()
                    .expect("Could not duplicate owned process handle"),
            ))
        }
    }
    let raw = child
        .as_raw_handle()
        .ok_or_else(|| anyhow::anyhow!("Child process handle is unavailable"))?;
    // SAFETY: the borrowed handle lives on child, which remains alive until the
    // duplicate is created. The resulting OwnedHandle has independent lifetime.
    let owned = unsafe { BorrowedHandle::borrow_raw(raw) }.try_clone_to_owned()?;
    Ok(Box::new(WindowsKiller(owned)))
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
