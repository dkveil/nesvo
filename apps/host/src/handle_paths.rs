use crate::process::display_path;
use std::{
    fs::File,
    io,
    path::{Path, PathBuf},
};

#[cfg(windows)]
pub(crate) fn final_path(file: &File) -> io::Result<PathBuf> {
    use std::{
        ffi::OsString,
        os::windows::{ffi::OsStringExt, io::AsRawHandle},
    };
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let mut buffer = vec![0u16; 512];
    for _ in 0..2 {
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        } as usize;
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        if length < buffer.len() {
            buffer.truncate(length);
            return Ok(PathBuf::from(OsString::from_wide(&buffer)));
        }
        buffer.resize(length + 1, 0);
    }
    Err(io::Error::other("the open file path kept growing"))
}

#[cfg(target_os = "linux")]
pub(crate) fn final_path(file: &File) -> io::Result<PathBuf> {
    use std::os::fd::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

#[cfg(target_os = "macos")]
pub(crate) fn final_path(file: &File) -> io::Result<PathBuf> {
    use std::{ffi::OsStr, os::fd::AsRawFd, os::unix::ffi::OsStrExt};
    let mut buffer = vec![0u8; libc::PATH_MAX as usize];
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }
    let length = buffer
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(buffer.len());
    Ok(PathBuf::from(OsStr::from_bytes(&buffer[..length])))
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub(crate) fn final_path(_file: &File) -> io::Result<PathBuf> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

#[cfg(windows)]
fn single_plain_entry(file: &File) -> io::Result<bool> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, GetFileInformationByHandle,
    };
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(information.nNumberOfLinks == 1
        && information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0)
}

#[cfg(unix)]
fn single_plain_entry(file: &File) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    Ok(file.metadata()?.nlink() == 1)
}

pub(crate) fn plain_file(file: &File) -> io::Result<bool> {
    let metadata = file.metadata()?;
    Ok(metadata.is_file() && !metadata.file_type().is_symlink() && single_plain_entry(file)?)
}

pub(crate) fn same_path(left: &Path, right: &Path) -> bool {
    let (left, right) = (display_path(left), display_path(right));
    if cfg!(windows) {
        left.to_lowercase() == right.to_lowercase()
    } else {
        left == right
    }
}

pub(crate) fn opened_inside(file: &File, directory: &Path) -> bool {
    final_path(file).is_ok_and(|resolved| {
        resolved
            .parent()
            .is_some_and(|parent| same_path(parent, directory))
    })
}
