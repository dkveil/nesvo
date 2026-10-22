use anyhow::{Context, Result};
use portable_pty::{Child, ChildKiller};
use std::{
    io,
    os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
    sync::Arc,
};
use windows_sys::Win32::System::{
    JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    },
    Threading::{GetExitCodeProcess, TerminateProcess},
};

#[derive(Debug)]
struct WindowsKiller(Arc<OwnedHandle>);

impl ChildKiller for WindowsKiller {
    fn kill(&mut self) -> io::Result<()> {
        // SAFETY: the shared OwnedHandle keeps this exact private job alive.
        if unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } != 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(Self(Arc::clone(&self.0)))
    }
}

pub fn killer(child: &dyn Child) -> Result<Box<dyn ChildKiller + Send + Sync>> {
    let raw = child
        .as_raw_handle()
        .context("Child process handle is unavailable")?;
    // SAFETY: child owns this live handle for the entire enrollment operation.
    let process = unsafe { BorrowedHandle::borrow_raw(raw) };
    match enroll(process) {
        Ok(job) => Ok(Box::new(WindowsKiller(Arc::new(job)))),
        Err(error) => {
            if unsafe { TerminateProcess(process.as_raw_handle(), 1) } == 0 {
                let mut status = 0;
                let queried = unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut status) };
                if queried == 0 || status == 259 {
                    return Err(error.context(format!(
                        "Uncontained native root termination failed: {}",
                        io::Error::last_os_error()
                    )));
                }
            }
            Err(error.context("Cannot enroll native session in its Windows process job"))
        }
    }
}

fn enroll(process: BorrowedHandle<'_>) -> Result<OwnedHandle> {
    // SAFETY: null attributes produce a private, noninheritable unnamed handle.
    let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if raw.is_null() {
        return Err(io::Error::last_os_error()).context("Create native session job");
    }
    // SAFETY: successful CreateJobObjectW returns an independently owned handle.
    let job = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: limits is initialized, correctly sized and lives through the call.
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&limits).cast(),
            std::mem::size_of_val(&limits) as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error()).context("Set native session job lifetime");
    }
    // SAFETY: both handles remain valid for the duration of the call.
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process.as_raw_handle()) } == 0 {
        return Err(io::Error::last_os_error()).context("Assign exact native process to job");
    }
    Ok(job)
}

pub fn command_job(child: &tokio::process::Child) -> Result<OwnedHandle> {
    let raw = child
        .raw_handle()
        .context("Command helper handle unavailable")?;
    // SAFETY: Child retains this handle throughout enrollment.
    enroll(unsafe { BorrowedHandle::borrow_raw(raw) })
}
pub fn terminate_command_job(job: &OwnedHandle) -> io::Result<()> {
    // SAFETY: the private owned handle pins this exact process job.
    if unsafe { TerminateJobObject(job.as_raw_handle(), 1) } != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
pub fn command_job_empty(job: &OwnedHandle) -> io::Result<bool> {
    use windows_sys::Win32::System::JobObjects::{
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JobObjectBasicAccountingInformation,
        QueryInformationJobObject,
    };
    let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    // SAFETY: owned live job, initialized output and exact structure size.
    if unsafe {
        QueryInformationJobObject(
            job.as_raw_handle(),
            JobObjectBasicAccountingInformation,
            std::ptr::from_mut(&mut info).cast(),
            std::mem::size_of_val(&info) as u32,
            std::ptr::null_mut(),
        )
    } == 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(info.ActiveProcesses == 0)
    }
}

#[cfg(test)]
#[path = "windows_process_tests.rs"]
mod tests;
