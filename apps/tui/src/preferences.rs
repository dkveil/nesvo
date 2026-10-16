//! Local presentation preferences. Pairing credentials are stored separately.
use crate::theme::Theme;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Preferences {
    pub theme: Theme,
    pub onboarded: bool,
}

impl Preferences {
    pub fn load(path: &Path) -> Result<Self> {
        match fs::metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default());
            }
            Err(error) => return Err(error).context("Cannot read nesvo preferences"),
            Ok(metadata) => ensure!(metadata.len() <= 8192, "Preferences file is too large"),
        }
        serde_json::from_slice(&fs::read(path)?).context("Invalid nesvo preferences")
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let parent = path
            .parent()
            .context("Preferences path needs a parent directory")?;
        fs::create_dir_all(parent).context("Cannot create preferences directory")?;
        let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
        let result = (|| -> Result<()> {
            let mut file = fs::File::create(&temporary)?;
            file.write_all(&serde_json::to_vec_pretty(self)?)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result.context("Cannot save nesvo preferences")
    }
}

pub fn default_path() -> Result<PathBuf> {
    let config = if cfg!(windows) {
        env::var_os("LOCALAPPDATA")
            .or_else(|| env::var_os("APPDATA"))
            .map(PathBuf::from)
    } else {
        env::var_os("XDG_CONFIG_HOME")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
    };
    Ok(config
        .context("Cannot find a user configuration directory")?
        .join("nesvo")
        .join("preferences.json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn missing_preferences_default_and_saved_choice_survives_replacement() {
        let directory = env::temp_dir().join(format!(
            "nesvo-preferences-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let path = directory.join("preferences.json");
        assert_eq!(Preferences::load(&path).unwrap(), Preferences::default());
        Preferences::default().save(&path).unwrap();
        let chosen = Preferences {
            theme: Theme::Graphite,
            onboarded: true,
        };
        chosen.save(&path).unwrap();
        assert_eq!(Preferences::load(&path).unwrap(), chosen);
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn unknown_theme_is_rejected_without_silently_resetting_a_saved_choice() {
        assert!(serde_json::from_str::<Preferences>(r#"{"theme":"missing-theme"}"#).is_err());
        let defaults: Preferences = serde_json::from_str("{}").unwrap();
        assert_eq!(defaults.theme, Theme::Ultraviolet);
    }
}
