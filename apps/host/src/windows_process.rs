use super::Lease;
use anyhow::{Context, Result};
use portable_pty::{Child, ChildKiller};
use std::{
    io,
    os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::Instant,
};
use windows_sys::Win32::{
    Foundation::{ERROR_MORE_DATA, INVALID_HANDLE_VALUE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::{
        IO::{CreateIoCompletionPort, GetQueuedCompletionStatus},
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_ASSOCIATE_COMPLETION_PORT,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectAssociateCompletionPortInformation,
            JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation,
            QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
        },
        LibraryLoader::{LOAD_LIBRARY_SEARCH_SYSTEM32, SetDefaultDllDirectories},
        Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE, TerminateProcess, WaitForMultipleObjects, WaitForSingleObject,
        },
    },
};

pub fn system_conpty() -> Result<()> {
    static FAILURE: std::sync::OnceLock<Option<i32>> = std::sync::OnceLock::new();
    let failure = *FAILURE.get_or_init(|| {
        // SAFETY: a documented constant flag; the call only narrows this process's DLL search.
        (unsafe { SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) } == 0).then(|| {
            io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or_default()
        })
    });
    match failure {
        None => Ok(()),
        Some(code) => Err(io::Error::from_raw_os_error(code))
            .context("Restrict ConPTY to the operating system's console host"),
    }
}

const MEMBER_LIST_CAPACITY: usize = 256;
const WAIT_OBJECTS_LIMIT: usize = 64;

#[repr(C)]
struct MemberList {
    _assigned: u32,
    listed: u32,
    ids: [usize; MEMBER_LIST_CAPACITY],
}

type Members = Vec<(u32, Arc<OwnedHandle>)>;

#[derive(Debug)]
pub struct Native {
    job: OwnedHandle,
    members: Mutex<Members>,
}

fn ended(process: &OwnedHandle) -> bool {
    // SAFETY: a pinned synchronize handle; a zero timeout only samples its state.
    (unsafe { WaitForSingleObject(process.as_raw_handle(), 0) }) == WAIT_OBJECT_0
}

fn member(job: &OwnedHandle, id: u32) -> Option<OwnedHandle> {
    // SAFETY: opens a listed id; membership of this exact process is rechecked below.
    let raw = unsafe {
        OpenProcess(
            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            id,
        )
    };
    if raw.is_null() {
        return None;
    }
    // SAFETY: a successful OpenProcess returns an independently owned handle.
    let process = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut inside = 0;
    // SAFETY: both owned handles stay live for this query and the output is initialized.
    let queried =
        unsafe { IsProcessInJob(process.as_raw_handle(), job.as_raw_handle(), &mut inside) };
    (queried != 0 && inside != 0).then_some(process)
}

impl Native {
    fn new(job: OwnedHandle) -> Self {
        Self {
            job,
            members: Mutex::new(Vec::new()),
        }
    }

    fn members(&self) -> MutexGuard<'_, Members> {
        self.members.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn pin(&self) -> io::Result<()> {
        let mut list = MemberList {
            _assigned: 0,
            listed: 0,
            ids: [0; MEMBER_LIST_CAPACITY],
        };
        // SAFETY: owned live job and an output buffer of exactly the declared size.
        if unsafe {
            QueryInformationJobObject(
                self.job.as_raw_handle(),
                JobObjectBasicProcessIdList,
                std::ptr::from_mut(&mut list).cast(),
                std::mem::size_of_val(&list) as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_MORE_DATA as i32) {
                return Err(error);
            }
        }
        let listed = (list.listed as usize).min(MEMBER_LIST_CAPACITY);
        let mut members = self.members();
        members.retain(|(_, process)| !ended(process));
        for id in list.ids[..listed]
            .iter()
            .filter_map(|id| u32::try_from(*id).ok())
        {
            if members.iter().any(|(pinned, _)| *pinned == id) {
                continue;
            }
            if let Some(process) = member(&self.job, id) {
                members.push((id, Arc::new(process)));
            }
        }
        Ok(())
    }

    fn terminate(&self) -> io::Result<()> {
        let _ = self.pin();
        terminate_command_job(&self.job)
    }

    pub(super) fn release(&self) {
        let _ = self.terminate();
    }

    pub(super) fn idle(&self) -> io::Result<bool> {
        if !command_job_empty(&self.job)? {
            return Ok(false);
        }
        let mut members = self.members();
        members.retain(|(_, process)| !ended(process));
        Ok(members.is_empty())
    }

    pub(super) fn watch(&self) -> io::Result<Watch> {
        // SAFETY: an invalid file handle with no existing port creates a new private port.
        let raw =
            unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, std::ptr::null_mut(), 0, 1) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a successful CreateIoCompletionPort returns an independently owned port.
        let port = unsafe { OwnedHandle::from_raw_handle(raw) };
        let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
            CompletionKey: std::ptr::null_mut(),
            CompletionPort: port.as_raw_handle(),
        };
        // SAFETY: owned live job and port, initialized structure of the exact size.
        if unsafe {
            SetInformationJobObject(
                self.job.as_raw_handle(),
                JobObjectAssociateCompletionPortInformation,
                std::ptr::from_ref(&association).cast(),
                std::mem::size_of_val(&association) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Watch(port))
    }
}

pub struct Watch(OwnedHandle);

impl Watch {
    pub(super) fn next(&mut self, native: &Native, deadline: Instant) -> io::Result<()> {
        native.pin()?;
        let pending: Vec<Arc<OwnedHandle>> = native
            .members()
            .iter()
            .map(|(_, process)| Arc::clone(process))
            .take(WAIT_OBJECTS_LIMIT)
            .collect();
        let remaining = deadline.saturating_duration_since(Instant::now());
        let milliseconds = u32::try_from(remaining.as_millis())
            .unwrap_or(u32::MAX)
            .min(u32::MAX - 1);
        if !pending.is_empty() {
            let handles: Vec<_> = pending
                .iter()
                .map(|process| process.as_raw_handle())
                .collect();
            // SAFETY: the cloned pins keep every handle open for this bounded wait.
            let signaled = unsafe {
                WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, milliseconds)
            };
            if signaled == WAIT_FAILED {
                return Err(io::Error::last_os_error());
            }
            return Ok(());
        }
        let mut message = 0;
        let mut key = 0;
        let mut overlapped = std::ptr::null_mut();
        // SAFETY: owned port and initialized outputs; job notifications carry no buffers.
        if unsafe {
            GetQueuedCompletionStatus(
                self.0.as_raw_handle(),
                &mut message,
                &mut key,
                &mut overlapped,
                milliseconds,
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(WAIT_TIMEOUT as i32) {
                return Err(error);
            }
        }
        Ok(())
    }
}

#[derive(Debug)]
struct WindowsKiller(Arc<Lease>);

impl ChildKiller for WindowsKiller {
    fn kill(&mut self) -> io::Result<()> {
        self.0.native().terminate()
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(Self(Arc::clone(&self.0)))
    }
}

pub fn killer(name: &str, child: &dyn Child) -> Result<Box<dyn ChildKiller + Send + Sync>> {
    let raw = child
        .as_raw_handle()
        .context("Child process handle is unavailable")?;
    // SAFETY: child owns this live handle for the entire enrollment operation.
    let process = unsafe { BorrowedHandle::borrow_raw(raw) };
    match enroll(process) {
        Ok(job) => Ok(Box::new(WindowsKiller(
            super::SESSION_JOBS.lease(name, Native::new(job)),
        ))),
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
pub(super) fn enrolled(child: &std::process::Child) -> Native {
    // SAFETY: the caller's Child retains this live process handle throughout enrollment.
    Native::new(
        enroll(unsafe { BorrowedHandle::borrow_raw(AsRawHandle::as_raw_handle(child)) }).unwrap(),
    )
}

#[cfg(test)]
#[path = "windows_process_tests.rs"]
mod tests;
