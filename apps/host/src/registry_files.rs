use crate::{
    caller::Authority,
    handle_paths::{self, without_links},
};
use anyhow::{Result, anyhow, ensure};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    fmt,
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, PoisonError},
};

pub(crate) fn owner_only(
    authority: &Authority,
    refused: impl FnOnce(&str) -> anyhow::Error,
) -> Result<()> {
    match authority {
        Authority::Owner => Ok(()),
        Authority::Session { id, .. } | Authority::RunWake { id, .. } => Err(refused(id)),
    }
}

#[derive(Debug)]
pub(crate) enum Refusal {
    Linked,
    NotDirectory,
    Missing,
    Unwritable(io::Error),
    Unreadable(io::Error),
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Linked => f.write_str("The path resolves outside its expected folder"),
            Self::NotDirectory => f.write_str("A folder level is not a folder"),
            Self::Missing => f.write_str("A folder level does not exist"),
            Self::Unwritable(error) => write!(f, "The file cannot be written: {error}"),
            Self::Unreadable(error) => write!(f, "The folder cannot be inspected: {error}"),
        }
    }
}

impl std::error::Error for Refusal {}

impl From<Refusal> for io::Error {
    fn from(refusal: Refusal) -> Self {
        match refusal {
            Refusal::Unwritable(error) | Refusal::Unreadable(error) => error,
            Refusal::Missing => io::Error::new(io::ErrorKind::NotFound, refusal.to_string()),
            Refusal::Linked | Refusal::NotDirectory => {
                io::Error::new(io::ErrorKind::PermissionDenied, refusal.to_string())
            }
        }
    }
}

pub(crate) fn replace(directory: &Path, name: &str, bytes: &[u8]) -> Result<(), Refusal> {
    let temporary = directory.join(format!(
        ".{name}.{}.tmp",
        hex::encode(crate::wire::random::<6>())
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    without_links(&mut options);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(Refusal::Unwritable)?;
    let written = if handle_paths::opened_inside(&file, directory) {
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(Refusal::Unwritable)
    } else {
        Err(Refusal::Linked)
    };
    drop(file);
    let replaced = written.and_then(|()| {
        std::fs::rename(&temporary, directory.join(name)).map_err(Refusal::Unwritable)
    });
    if replaced.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    replaced
}

fn descend(path: &Path, create: bool) -> Result<(), Refusal> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(Refusal::Linked),
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(Refusal::NotDirectory),
        Err(error) if error.kind() == io::ErrorKind::NotFound && create => {
            match std::fs::create_dir(path) {
                Ok(()) => descend(path, false),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => descend(path, false),
                Err(error) => Err(Refusal::Unwritable(error)),
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Err(Refusal::Missing),
        Err(error) => Err(Refusal::Unreadable(error)),
    }
}

pub(crate) fn walk(base: &Path, levels: &[&str], create: bool) -> Result<PathBuf, Refusal> {
    let mut directory = base.to_owned();
    for level in levels {
        directory.push(level);
        descend(&directory, create)?;
    }
    let resolved = std::fs::canonicalize(&directory).map_err(|_| Refusal::Linked)?;
    if !handle_paths::same_path(&resolved, &directory) {
        return Err(Refusal::Linked);
    }
    Ok(directory)
}

pub(crate) fn open_plain(path: &Path) -> io::Result<File> {
    let directory = path.parent().ok_or(Refusal::Linked)?;
    let mut options = OpenOptions::new();
    options.write(true).create(true);
    without_links(&mut options);
    let file = options.open(path)?;
    if !handle_paths::opened_inside(&file, directory) || !handle_paths::plain_file(&file)? {
        return Err(Refusal::Linked.into());
    }
    file.set_len(0)?;
    Ok(file)
}

pub(crate) struct Registry<D> {
    directory: PathBuf,
    file: &'static str,
    label: &'static str,
    document: Mutex<D>,
    writing: tokio::sync::Mutex<()>,
}

impl<D: Clone + Serialize + DeserializeOwned> Registry<D> {
    pub(crate) fn open(
        directory: &Path,
        file: &'static str,
        label: &'static str,
        limit: u64,
        empty: impl FnOnce() -> D,
        supported: impl FnOnce(&D) -> bool,
    ) -> Result<Self> {
        let directory = std::fs::canonicalize(directory).unwrap_or_else(|_| directory.to_owned());
        let document = match File::open(directory.join(file)) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => empty(),
            Err(error) => return Err(error.into()),
            Ok(opened) => {
                let mut bytes = Vec::new();
                opened.take(limit + 1).read_to_end(&mut bytes)?;
                ensure!(bytes.len() as u64 <= limit, "{label} is too large");
                let document: D = serde_json::from_slice(&bytes)?;
                ensure!(supported(&document), "{label} has an unsupported version");
                document
            }
        };
        Ok(Self {
            directory,
            file,
            label,
            document: Mutex::new(document),
            writing: tokio::sync::Mutex::new(()),
        })
    }

    pub(crate) fn amend(&mut self, change: impl FnOnce(&mut D)) {
        change(
            self.document
                .get_mut()
                .unwrap_or_else(PoisonError::into_inner),
        );
    }

    fn lock(&self) -> Result<MutexGuard<'_, D>> {
        self.document
            .lock()
            .map_err(|_| anyhow!("{} is unavailable", self.label))
    }

    pub(crate) fn read<T>(&self, view: impl FnOnce(&D) -> T) -> Result<T> {
        Ok(view(&*self.lock()?))
    }

    pub(crate) fn update<T>(&self, change: impl FnOnce(&mut D) -> Result<T>) -> Result<T> {
        let mut document = self.lock()?;
        let _writing = self
            .writing
            .try_lock()
            .map_err(|_| anyhow!("{} is being written", self.label))?;
        let mut next = document.clone();
        let value = change(&mut next)?;
        replace(
            &self.directory,
            self.file,
            &serde_json::to_vec_pretty(&next)?,
        )?;
        *document = next;
        Ok(value)
    }

    pub(crate) async fn update_async<T>(
        &self,
        change: impl FnOnce(&mut D) -> Result<T>,
    ) -> Result<T>
    where
        D: Send + 'static,
    {
        let _writing = self.writing.lock().await;
        let mut next = self.read(D::clone)?;
        let value = change(&mut next)?;
        let bytes = serde_json::to_vec_pretty(&next)?;
        let (directory, file) = (self.directory.clone(), self.file);
        tokio::task::spawn_blocking(move || replace(&directory, file, &bytes))
            .await
            .map_err(|_| anyhow!("{} write was interrupted", self.label))??;
        *self.lock()? = next;
        Ok(value)
    }
}

#[cfg(test)]
pub(crate) fn link_directory(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(target, link).is_ok()
            || std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(crate::process::display_path(link))
                .arg(crate::process::display_path(target))
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
    }
}

#[cfg(test)]
#[path = "registry_files_tests.rs"]
mod tests;
