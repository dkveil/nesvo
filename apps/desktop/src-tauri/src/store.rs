use crate::pairing::Pairing;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

const PAIRING_FILE: &str = "pairing.json";
const SETTINGS_FILE: &str = "settings.json";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    pub port: Option<u16>,
}

pub struct ConfigStore {
    directory: PathBuf,
}

impl ConfigStore {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    pub fn load_pairing(&self) -> Option<Pairing> {
        let text = fs::read_to_string(self.directory.join(PAIRING_FILE)).ok()?;
        Pairing::parse(&text).ok()
    }

    pub fn save_pairing(&self, pairing: &Pairing) -> Result<()> {
        self.write(PAIRING_FILE, &serde_json::to_vec_pretty(pairing)?)
    }

    pub fn clear_pairing(&self) -> Result<()> {
        match fs::remove_file(self.directory.join(PAIRING_FILE)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }

    pub fn load_settings(&self) -> Settings {
        fs::read(self.directory.join(SETTINGS_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        self.write(SETTINGS_FILE, &serde_json::to_vec_pretty(settings)?)
    }

    fn write(&self, name: &str, bytes: &[u8]) -> Result<()> {
        create_private_directory(&self.directory).context("Cannot create the config directory")?;
        let target = self.directory.join(name);
        let temporary = self.directory.join(format!("{name}.tmp"));
        write_private_file(&temporary, bytes)?;
        fs::rename(&temporary, &target)?;
        Ok(())
    }
}

#[cfg(unix)]
fn create_private_directory(path: &Path) -> Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn create_private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    Ok(())
}

#[cfg(unix)]
fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let _ = fs::remove_file(path);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::write(path, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairing() -> Pairing {
        Pairing::parse(&format!(
            r#"{{"version":1,"url":"ws://host:1","key":"{}"}}"#,
            "cd".repeat(32)
        ))
        .unwrap()
    }

    #[test]
    fn pairing_and_settings_round_trip_and_clear() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(directory.path().join("nested"));
        assert!(store.load_pairing().is_none());
        assert_eq!(store.load_settings(), Settings::default());
        store.save_pairing(&pairing()).unwrap();
        store.save_settings(&Settings { port: Some(8791) }).unwrap();
        assert_eq!(store.load_pairing(), Some(pairing()));
        assert_eq!(store.load_settings().port, Some(8791));
        store.clear_pairing().unwrap();
        store.clear_pairing().unwrap();
        assert!(store.load_pairing().is_none());
    }
}
