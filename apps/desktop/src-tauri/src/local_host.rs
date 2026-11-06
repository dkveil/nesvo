use crate::{link::open, pairing::Pairing};
use anyhow::{Context, Result, anyhow, ensure};
use std::{
    env,
    ffi::OsString,
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use tokio::time::sleep;

pub const LOCAL_HOST_DIRECTORY: &str = "local-host";
const PAIRING_FILE: &str = "pairing.json";
const PID_FILE: &str = "host.pid";
const LOG_FILE: &str = "host.log";
const HOST_BINARY_ENV: &str = "NESVO_HOST_BIN";
const HOST_PROCESS_NAME: &str = "nesvo-host";
const WINDOWS_DATA_DIRECTORY: &str = "PocketSessions";
const UNIX_DATA_DIRECTORY: &str = "pocket-sessions";
const PAIRING_WAIT: Duration = Duration::from_secs(15);
const PAIRING_POLL: Duration = Duration::from_millis(250);

#[cfg(windows)]
const HOST_BINARY_NAME: &str = "nesvo-host.exe";
#[cfg(not(windows))]
const HOST_BINARY_NAME: &str = "nesvo-host";

#[derive(Clone, Debug)]
pub struct LocalHostConfig {
    pub state_dir: PathBuf,
    pub port: u16,
    pub binary_override: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalTarget {
    pub url: String,
    pub key: [u8; 32],
}

pub fn local_directory(state_dir: &Path) -> PathBuf {
    state_dir.join(LOCAL_HOST_DIRECTORY)
}

pub fn candidate_pairing_directories(state_dir: &Path) -> Vec<PathBuf> {
    let mut directories = vec![local_directory(state_dir)];
    directories.extend(default_host_pairing_directory(
        env::var_os("LOCALAPPDATA"),
        env::var_os("XDG_STATE_HOME"),
        env::var_os("HOME"),
    ));
    directories
}

fn default_host_pairing_directory(
    local_app_data: Option<OsString>,
    xdg_state_home: Option<OsString>,
    home: Option<OsString>,
) -> Option<PathBuf> {
    if cfg!(windows) {
        local_app_data.map(|base| {
            PathBuf::from(base)
                .join(WINDOWS_DATA_DIRECTORY)
                .join("pairing")
        })
    } else {
        xdg_state_home
            .map(PathBuf::from)
            .or_else(|| home.map(|home| PathBuf::from(home).join(".local/state")))
            .map(|base| base.join(UNIX_DATA_DIRECTORY))
    }
}

pub async fn probe(directory: &Path) -> Option<LocalTarget> {
    let text = fs::read_to_string(directory.join(PAIRING_FILE)).ok()?;
    let pairing = Pairing::parse(&text).ok()?;
    let url = pairing.host_url(None).ok()?;
    let key = pairing.key_bytes().ok()?;
    open(&url, key).await.ok()?;
    Some(LocalTarget { url, key })
}

#[derive(Clone, Debug, Default)]
pub struct BinarySearch {
    pub override_path: Option<PathBuf>,
    pub env_binary: Option<PathBuf>,
    pub executable_directory: Option<PathBuf>,
    pub working_directory: Option<PathBuf>,
    pub cargo_target_directory: Option<PathBuf>,
    pub path_variable: Option<OsString>,
}

impl BinarySearch {
    pub fn from_environment(override_path: Option<PathBuf>) -> Self {
        Self {
            override_path,
            env_binary: env::var_os(HOST_BINARY_ENV).map(PathBuf::from),
            executable_directory: env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(Path::to_path_buf)),
            working_directory: env::current_dir().ok(),
            cargo_target_directory: env::var_os("CARGO_TARGET_DIR").map(PathBuf::from),
            path_variable: env::var_os("PATH"),
        }
    }

    pub fn resolve(&self) -> Option<PathBuf> {
        self.candidates().into_iter().find(|path| path.is_file())
    }

    fn candidates(&self) -> Vec<PathBuf> {
        let mut candidates: Vec<PathBuf> = vec![];
        candidates.extend(self.override_path.clone());
        candidates.extend(self.env_binary.clone());
        candidates.extend(
            self.executable_directory
                .iter()
                .map(|directory| directory.join(HOST_BINARY_NAME)),
        );
        for start in [&self.executable_directory, &self.working_directory]
            .into_iter()
            .flatten()
        {
            for ancestor in start.ancestors() {
                candidates.extend(build_outputs(&ancestor.join("target")));
            }
        }
        if let Some(target) = &self.cargo_target_directory {
            candidates.extend(build_outputs(target));
        }
        if let Some(path_variable) = &self.path_variable {
            candidates.extend(
                env::split_paths(path_variable).map(|directory| directory.join(HOST_BINARY_NAME)),
            );
        }
        candidates
    }
}

fn build_outputs(target: &Path) -> [PathBuf; 2] {
    [
        target.join("debug").join(HOST_BINARY_NAME),
        target.join("release").join(HOST_BINARY_NAME),
    ]
}

#[allow(clippy::zombie_processes)]
pub fn spawn_host(binary: &Path, pairing_dir: &Path, port: u16) -> Result<u32> {
    fs::create_dir_all(pairing_dir).context("Cannot create the local host directory")?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(pairing_dir.join(LOG_FILE))
        .context("Cannot open the local host log")?;
    let mut command = Command::new(binary);
    command
        .args(["--bind", "127.0.0.1", "--port"])
        .arg(port.to_string())
        .arg("--pairing-dir")
        .arg(pairing_dir)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    if let Some(home) = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")) {
        command.arg("--workspace").arg(&home).current_dir(home);
    }
    detach(&mut command);
    let child = command
        .spawn()
        .with_context(|| format!("Cannot start {}", binary.display()))?;
    let pid = child.id();
    fs::write(pairing_dir.join(PID_FILE), pid.to_string())?;
    Ok(pid)
}

#[cfg(windows)]
fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
}

#[cfg(unix)]
fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

pub async fn wait_for_pairing(directory: &Path) -> Result<LocalTarget> {
    let deadline = Instant::now() + PAIRING_WAIT;
    loop {
        if let Some(target) = probe(directory).await {
            return Ok(target);
        }
        ensure!(
            Instant::now() < deadline,
            "The local host did not become ready; see {}",
            directory.join(LOG_FILE).display()
        );
        sleep(PAIRING_POLL).await;
    }
}

pub async fn ensure(config: &LocalHostConfig) -> Result<LocalTarget> {
    for directory in candidate_pairing_directories(&config.state_dir) {
        if let Some(target) = probe(&directory).await {
            return Ok(target);
        }
    }
    let binary = BinarySearch::from_environment(config.binary_override.clone())
        .resolve()
        .ok_or_else(|| {
            anyhow!(
                "Cannot find nesvo-host; set the host binary path in Settings or NESVO_HOST_BIN"
            )
        })?;
    let directory = local_directory(&config.state_dir);
    spawn_host(&binary, &directory, config.port)?;
    wait_for_pairing(&directory).await
}

fn pid_belongs_to_host(pid: u32) -> bool {
    let pid_text = pid.to_string();
    let output = if cfg!(windows) {
        let filter = format!("PID eq {pid_text}");
        Command::new("tasklist")
            .args(["/FI", filter.as_str(), "/FO", "CSV", "/NH"])
            .output()
    } else {
        Command::new("ps")
            .args(["-p", pid_text.as_str(), "-o", "comm="])
            .output()
    };
    output.is_ok_and(|output| {
        String::from_utf8_lossy(&output.stdout)
            .to_lowercase()
            .contains(HOST_PROCESS_NAME)
    })
}

fn kill(pid: u32) -> Result<()> {
    let pid_text = pid.to_string();
    let status = if cfg!(windows) {
        Command::new("taskkill")
            .args(["/PID", pid_text.as_str(), "/T", "/F"])
            .status()
    } else {
        Command::new("kill").arg(pid_text.as_str()).status()
    }?;
    ensure!(status.success(), "Could not stop the local host");
    Ok(())
}

pub fn stop(state_dir: &Path) -> Result<()> {
    let pid_path = local_directory(state_dir).join(PID_FILE);
    let Ok(text) = fs::read_to_string(&pid_path) else {
        return Ok(());
    };
    let pid: u32 = text.trim().parse().context("Invalid local host pid file")?;
    if pid_belongs_to_host(pid) {
        kill(pid)?;
    }
    let _ = fs::remove_file(pid_path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"").unwrap();
    }

    #[test]
    fn the_app_directory_is_probed_before_the_host_default() {
        let directories = candidate_pairing_directories(Path::new("state"));
        assert_eq!(
            directories[0],
            Path::new("state").join(LOCAL_HOST_DIRECTORY)
        );
    }

    #[test]
    fn the_default_host_directory_follows_the_platform_layout() {
        let resolved = default_host_pairing_directory(
            Some("C:\\Local".into()),
            Some("/state".into()),
            Some("/home/me".into()),
        )
        .unwrap();
        if cfg!(windows) {
            assert_eq!(
                resolved,
                PathBuf::from("C:\\Local")
                    .join("PocketSessions")
                    .join("pairing")
            );
        } else {
            assert_eq!(resolved, PathBuf::from("/state").join("pocket-sessions"));
        }
    }

    #[test]
    fn binary_resolution_prefers_the_override_then_the_environment() {
        let directory = tempfile::tempdir().unwrap();
        let override_path = directory.path().join("override").join(HOST_BINARY_NAME);
        let env_path = directory.path().join("env").join(HOST_BINARY_NAME);
        touch(&override_path);
        touch(&env_path);
        let search = BinarySearch {
            override_path: Some(override_path.clone()),
            env_binary: Some(env_path.clone()),
            ..BinarySearch::default()
        };
        assert_eq!(search.resolve(), Some(override_path));
        let search = BinarySearch {
            override_path: Some(directory.path().join("missing")),
            env_binary: Some(env_path.clone()),
            ..BinarySearch::default()
        };
        assert_eq!(search.resolve(), Some(env_path));
    }

    #[test]
    fn binary_resolution_finds_a_repository_build_above_the_executable() {
        let directory = tempfile::tempdir().unwrap();
        let built = directory
            .path()
            .join("target")
            .join("debug")
            .join(HOST_BINARY_NAME);
        touch(&built);
        let search = BinarySearch {
            executable_directory: Some(directory.path().join("apps").join("desktop")),
            ..BinarySearch::default()
        };
        assert_eq!(search.resolve(), Some(built));
    }

    #[test]
    fn binary_resolution_falls_back_to_the_path_variable_and_can_fail() {
        let directory = tempfile::tempdir().unwrap();
        let on_path = directory.path().join("bin").join(HOST_BINARY_NAME);
        touch(&on_path);
        let path_variable = env::join_paths([directory.path().join("bin")]).unwrap();
        let search = BinarySearch {
            path_variable: Some(path_variable),
            ..BinarySearch::default()
        };
        assert_eq!(search.resolve(), Some(on_path));
        assert_eq!(BinarySearch::default().resolve(), None);
    }

    #[test]
    fn stopping_without_a_pid_file_is_a_no_op() {
        let directory = tempfile::tempdir().unwrap();
        assert!(stop(directory.path()).is_ok());
    }
}
