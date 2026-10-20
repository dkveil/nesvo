#[cfg(not(windows))]
use anyhow::Result;
#[cfg(not(windows))]
use portable_pty::{Child, ChildKiller};

#[cfg(not(windows))]
pub fn killer(child: &dyn Child) -> Result<Box<dyn ChildKiller + Send + Sync>> {
    Ok(child.clone_killer())
}

#[cfg(windows)]
#[path = "windows_process.rs"]
mod windows;
#[cfg(windows)]
pub use windows::killer;

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
