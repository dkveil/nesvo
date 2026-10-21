use anyhow::{Context, Result, anyhow, ensure};
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Program {
    #[default]
    Shell,
    Claude,
    Gemini,
    Codex,
}

impl Program {
    const ALL: [Self; 4] = [Self::Shell, Self::Claude, Self::Gemini, Self::Codex];

    fn executable(self) -> &'static str {
        match self {
            Self::Shell => "shell",
            Self::Claude => "claude",
            Self::Gemini => "gemini",
            Self::Codex => "codex",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Shell => "Shell",
            Self::Claude => "Claude Code",
            Self::Gemini => "Gemini CLI",
            Self::Codex => "Codex",
        }
    }

    #[cfg(windows)]
    fn package(self) -> &'static str {
        match self {
            Self::Shell => "",
            Self::Claude => "@anthropic-ai/claude-code",
            Self::Gemini => "@google/gemini-cli",
            Self::Codex => "@openai/codex",
        }
    }
}

#[derive(Serialize)]
pub struct Capability {
    id: Program,
    label: &'static str,
    available: bool,
}
#[derive(Clone, Serialize)]
pub struct Version {
    pub program: Program,
    pub status: &'static str,
    pub version: Option<String>,
}

struct Launcher {
    executable: PathBuf,
    args: Vec<OsString>,
}

impl Launcher {
    fn direct(executable: PathBuf) -> Self {
        Self {
            executable,
            args: Vec::new(),
        }
    }

    fn command(&self, cwd: &Path) -> CommandBuilder {
        let mut command = CommandBuilder::new(crate::process::display_path(&self.executable));
        command.args(&self.args);
        command.cwd(crate::process::display_path(cwd));
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("NESVO_SESSION", "1");
        // Each native process receives its own caller binding later at spawn.
        for key in [
            "NESVO_AGENT_CONTEXT",
            "NESVO_AGENT_SKILL",
            "NESVO_CLI",
            "NESVO_GEMINI_HOOK",
            "NESVO_LIFECYCLE_REPORT",
        ] {
            command.env_remove(key);
        }
        // Codex and CI commonly run the host with NO_COLOR=1. That setting
        // belongs to the host's own output, not to the interactive PTY viewed
        // on another terminal or phone. Let each CLI emit its native colors.
        command.env_remove("NO_COLOR");
        command
    }
}

// Resolve once at startup. Capabilities never run a CLI or inspect credentials.
pub struct Launchers {
    entries: Vec<(Program, Option<Launcher>)>,
}

impl Launchers {
    pub fn version_probes(&self) -> Vec<(Program, PathBuf, Vec<OsString>)> {
        Program::ALL
            .into_iter()
            .skip(1)
            .filter_map(|program| {
                self.probe_command(program)
                    .map(|(exe, args)| (program, exe, args))
            })
            .collect()
    }
    pub fn pending_versions(&self) -> Vec<Version> {
        Program::ALL
            .into_iter()
            .skip(1)
            .filter(|program| self.available(*program))
            .map(|program| Version {
                program,
                status: "checking",
                version: None,
            })
            .collect()
    }
    pub fn discover() -> Self {
        Self::discover_in(&search_paths(), shell())
    }

    #[cfg(test)]
    pub fn discover_with_fixture_shell() -> Self {
        let shell = Launcher {
            executable: process_fixture::executable().to_owned(),
            args: vec!["hold".into()],
        };
        Self::discover_in(&search_paths(), Some(shell))
    }

    fn discover_in(paths: &[PathBuf], shell: Option<Launcher>) -> Self {
        let mut entries = vec![(Program::Shell, shell)];
        for program in Program::ALL.into_iter().skip(1) {
            entries.push((program, find_program(program, paths)));
        }
        Self { entries }
    }

    pub fn capabilities(&self) -> Vec<Capability> {
        self.entries
            .iter()
            .map(|(id, launcher)| Capability {
                id: *id,
                label: id.label(),
                available: launcher.is_some(),
            })
            .collect()
    }

    pub fn available(&self, program: Program) -> bool {
        self.entries
            .iter()
            .any(|(id, launcher)| *id == program && launcher.is_some())
    }

    /// Reuse the resolved launcher for read-only CLI integration, including npm's Windows wrapper.
    pub fn probe_command(&self, program: Program) -> Option<(PathBuf, Vec<OsString>)> {
        self.entries
            .iter()
            .find(|(id, _)| *id == program)
            .and_then(|(_, launcher)| launcher.as_ref())
            .map(|launcher| (launcher.executable.clone(), launcher.args.clone()))
    }

    pub fn command(&self, program: Program, cwd: &Path) -> Result<CommandBuilder> {
        self.entries
            .iter()
            .find(|(id, _)| *id == program)
            .and_then(|(_, launcher)| launcher.as_ref())
            .map(|launcher| launcher.command(cwd))
            .ok_or_else(|| {
                anyhow!(
                    "{} is not available on this host. Install it and restart the host.",
                    program.label()
                )
            })
    }
}
pub async fn read_version(program: Program, executable: PathBuf, args: Vec<OsString>) -> Version {
    use tokio::io::AsyncReadExt;
    let mut command = tokio::process::Command::new(executable);
    command
        .args(args)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let version = match command.spawn() {
        Err(_) => None,
        Ok(mut child) => {
            let result = tokio::time::timeout(std::time::Duration::from_secs(2), async {
                let mut bytes = Vec::new();
                let stdout = child.stdout.take()?;
                stdout.take(1025).read_to_end(&mut bytes).await.ok()?;
                if bytes.len() > 1024 || !child.wait().await.ok()?.success() {
                    return None;
                }
                let text = std::str::from_utf8(&bytes).ok()?;
                text.split_whitespace()
                    .find(|token| valid_version(token))
                    .map(str::to_owned)
            })
            .await;
            if result.is_err() {
                let _ = child.kill().await;
            }
            result.ok().flatten()
        }
    };
    Version {
        program,
        status: if version.is_some() {
            "ready"
        } else {
            "unavailable"
        },
        version,
    }
}
fn valid_version(value: &str) -> bool {
    value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b))
        && value.split('.').take(3).count() == 3
        && value
            .split('.')
            .take(3)
            .all(|part| part.bytes().next().is_some_and(|b| b.is_ascii_digit()))
}

fn executable(path: &Path) -> Option<PathBuf> {
    let path = path.canonicalize().ok()?;
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(path)
}

fn search_paths() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .filter(|path| !path.as_os_str().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod process_fixture {
    include!("../../../crates/nesvo-process-fixture/src/locate.rs");
}

fn shell() -> Option<Launcher> {
    #[cfg(windows)]
    {
        let root = PathBuf::from(std::env::var_os("SystemRoot")?);
        let path = executable(&root.join("System32/WindowsPowerShell/v1.0/powershell.exe"))?;
        Some(Launcher {
            executable: path,
            args: vec!["-NoLogo".into(), "-NoProfile".into()],
        })
    }
    #[cfg(not(windows))]
    {
        let path = std::env::var_os("SHELL")
            .and_then(|path| executable(Path::new(&path)))
            .or_else(|| executable(Path::new("/bin/sh")))?;
        Some(Launcher::direct(path))
    }
}

fn find_program(program: Program, paths: &[PathBuf]) -> Option<Launcher> {
    for directory in paths {
        #[cfg(windows)]
        {
            if let Some(path) = executable(&directory.join(format!("{}.exe", program.executable())))
            {
                return Some(Launcher::direct(path));
            }
            // npm's Windows wrappers cannot be passed to CreateProcess directly.
            // Resolve their known package entrypoint and pass it as a Node argv;
            // never interpolate paths into cmd.exe or PowerShell source.
            if ["cmd", "ps1", "bat"].iter().any(|extension| {
                directory
                    .join(format!("{}.{extension}", program.executable()))
                    .is_file()
            }) && let Some(launcher) = npm_launcher(program, directory, paths)
            {
                return Some(launcher);
            }
        }
        #[cfg(not(windows))]
        if let Some(path) = executable(&directory.join(program.executable())) {
            return Some(Launcher::direct(path));
        }
    }
    None
}

#[cfg(windows)]
fn npm_launcher(program: Program, directory: &Path, paths: &[PathBuf]) -> Option<Launcher> {
    use std::io::Read;
    let package = directory
        .join("node_modules")
        .join(program.package())
        .canonicalize()
        .ok()?;
    let mut manifest = Vec::new();
    fs::File::open(package.join("package.json"))
        .ok()?
        .take(128 * 1024 + 1)
        .read_to_end(&mut manifest)
        .ok()?;
    if manifest.len() > 128 * 1024 {
        return None;
    }
    let manifest: serde_json::Value = serde_json::from_slice(&manifest).ok()?;
    let bin = manifest.get("bin")?;
    let bin = bin
        .as_str()
        .or_else(|| bin.get(program.executable())?.as_str())?;
    let script = package.join(bin).canonicalize().ok()?;
    if !script.starts_with(&package)
        || !script.is_file()
        || !matches!(
            script.extension().and_then(|extension| extension.to_str()),
            Some("js" | "cjs" | "mjs")
        )
    {
        return None;
    }
    let node = std::iter::once(directory)
        .chain(paths.iter().map(PathBuf::as_path))
        .find_map(|directory| executable(&directory.join("node.exe")))?;
    Some(Launcher {
        executable: node,
        args: vec![crate::process::display_path(&script).into()],
    })
}

pub fn working_directory(workspace: &Path, cwd: Option<&str>) -> Result<PathBuf> {
    let cwd = cwd.unwrap_or_default();
    ensure!(
        cwd.len() <= 32 * 1024 && !cwd.chars().any(char::is_control),
        "Invalid starting directory."
    );
    let path = if cwd.trim().is_empty() {
        workspace.to_owned()
    } else {
        workspace.join(cwd)
    };
    let path = path
        .canonicalize()
        .context("Starting directory does not exist or cannot be accessed.")?;
    ensure!(path.is_dir(), "Starting directory must be a directory.");
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interactive_session_does_not_inherit_host_no_color() {
        let launcher = Launcher::direct(PathBuf::from("shell"));
        let command = launcher.command(Path::new("."));
        assert!(command.get_env("NO_COLOR").is_none());
        assert_eq!(
            command.get_env("TERM"),
            Some(std::ffi::OsStr::new("xterm-256color"))
        );
        assert_eq!(
            command.get_env("COLORTERM"),
            Some(std::ffi::OsStr::new("truecolor"))
        );
        assert_eq!(
            command.get_env("NESVO_SESSION"),
            Some(std::ffi::OsStr::new("1"))
        );
    }

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "nesvo-launchers-{}",
                hex::encode(crate::wire::random::<8>())
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn file(&self, name: &str, content: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, content).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn cwd_defaults_resolves_relative_and_accepts_other_repositories() {
        let fixture = Fixture::new();
        let workspace = fixture.0.join("workspace");
        let outside = fixture.0.join("other repo & %literal%");
        fs::create_dir_all(workspace.join("nested")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        assert_eq!(
            working_directory(&workspace, None).unwrap(),
            workspace.canonicalize().unwrap()
        );
        assert_eq!(
            working_directory(&workspace, Some("   ")).unwrap(),
            workspace.canonicalize().unwrap()
        );
        assert_eq!(
            working_directory(&workspace, Some("nested")).unwrap(),
            workspace.join("nested").canonicalize().unwrap()
        );
        assert_eq!(
            working_directory(&workspace, outside.to_str()).unwrap(),
            outside.canonicalize().unwrap()
        );
        assert_eq!(
            working_directory(&workspace, Some("../other repo & %literal%")).unwrap(),
            outside.canonicalize().unwrap()
        );
        let file = fixture.file("file.txt", "not a directory");
        assert!(working_directory(&workspace, file.to_str()).is_err());
        assert!(working_directory(&workspace, Some("missing")).is_err());
        assert!(working_directory(&workspace, Some("bad\0path")).is_err());
    }

    #[test]
    fn missing_programs_are_unavailable_and_discovery_is_a_snapshot() {
        let fixture = Fixture::new();
        let launchers = Launchers::discover_in(std::slice::from_ref(&fixture.0), None);
        let capabilities = launchers.capabilities();
        assert_eq!(capabilities.len(), 4);
        assert!(capabilities.iter().all(|entry| !entry.available));
        assert!(launchers.command(Program::Gemini, &fixture.0).is_err());
        let name = if cfg!(windows) {
            "gemini.exe"
        } else {
            "gemini"
        };
        let path = fixture.file(name, "fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        #[cfg(windows)]
        let _ = path;
        assert!(!launchers.capabilities()[2].available);
        let refreshed = Launchers::discover_in(std::slice::from_ref(&fixture.0), None);
        assert!(refreshed.capabilities()[2].available);
    }

    #[cfg(windows)]
    #[test]
    fn npm_shims_resolve_to_literal_node_argv_and_reject_unsafe_or_unsupported_bins() {
        let fixture = Fixture::new();
        fixture.file("node.exe", "test executable");
        fixture.file("gemini.cmd", "not executed");
        fixture.file(
            "node_modules/@google/gemini-cli/package.json",
            r#"{"bin":{"gemini":"dist/main.js"}}"#,
        );
        let script = fixture.file(
            "node_modules/@google/gemini-cli/dist/main.js",
            "console.log('fixture')",
        );
        let launcher = find_program(Program::Gemini, std::slice::from_ref(&fixture.0)).unwrap();
        assert_eq!(
            launcher.executable,
            fixture.0.join("node.exe").canonicalize().unwrap()
        );
        assert_eq!(
            launcher.args,
            vec![OsString::from(crate::process::display_path(
                &script.canonicalize().unwrap()
            ))]
        );
        fixture.file(
            "node_modules/@google/gemini-cli/package.json",
            r#"{"bin":{"gemini":"../../../outside.js"}}"#,
        );
        fixture.file("outside.js", "not allowed");
        assert!(find_program(Program::Gemini, std::slice::from_ref(&fixture.0)).is_none());
        fixture.file(
            "node_modules/@google/gemini-cli/package.json",
            r#"{"bin":{"gemini":"custom.cmd"}}"#,
        );
        fixture.file(
            "node_modules/@google/gemini-cli/custom.cmd",
            "not supported",
        );
        assert!(find_program(Program::Gemini, std::slice::from_ref(&fixture.0)).is_none());
        fixture.file("claude.cmd", "custom wrapper with no known package");
        assert!(find_program(Program::Claude, std::slice::from_ref(&fixture.0)).is_none());
    }
}

/// Explicit user selection in the CLI avoids guessing which conversation belongs to a process.
pub fn resume_arguments(program: Program) -> Result<&'static [&'static str]> {
    match program {
        Program::Claude => Ok(&["--resume"]),
        Program::Codex => Ok(&["resume"]),
        _ => Err(anyhow!(
            "Conversation picker is currently supported for Claude and Codex only"
        )),
    }
}

pub fn conversation_resume_arguments(
    program: Program,
    target: &crate::resume::Target,
) -> Result<Vec<String>> {
    crate::resume::check_target(program, target)?;
    let command = match program {
        Program::Claude => "--resume",
        Program::Codex => "resume",
        Program::Gemini | Program::Shell => {
            return Err(anyhow!("Exact conversation resume is unsupported"));
        }
    };
    Ok(vec![command.to_owned(), target.conversation_id.clone()])
}

#[cfg(test)]
mod resume_tests {
    use super::*;
    #[test]
    fn resume_opens_provider_picker_without_prompt_or_latest_guess() {
        assert_eq!(resume_arguments(Program::Claude).unwrap(), ["--resume"]);
        assert_eq!(resume_arguments(Program::Codex).unwrap(), ["resume"]);
        assert!(resume_arguments(Program::Shell).is_err());
        assert!(resume_arguments(Program::Gemini).is_err());
    }

    #[test]
    fn resume_exact_id_arguments_per_provider_never_open_a_picker_or_latest() {
        let id = "0f8fad5b-d9cb-469f-a165-70867728950e";
        let target = |provider| crate::resume::Target {
            provider,
            conversation_id: id.into(),
        };
        assert_eq!(
            conversation_resume_arguments(Program::Claude, &target(Program::Claude)).unwrap(),
            ["--resume", id]
        );
        assert_eq!(
            conversation_resume_arguments(Program::Codex, &target(Program::Codex)).unwrap(),
            ["resume", id]
        );
        let gemini =
            conversation_resume_arguments(Program::Gemini, &target(Program::Gemini)).unwrap_err();
        assert_eq!(
            gemini
                .downcast_ref::<crate::api_error::Error>()
                .unwrap()
                .code,
            "unsupported"
        );
        assert!(gemini.to_string().contains("Gemini"));
        assert!(conversation_resume_arguments(Program::Shell, &target(Program::Shell)).is_err());
        assert!(conversation_resume_arguments(Program::Codex, &target(Program::Claude)).is_err());
        let latest = crate::resume::Target {
            provider: Program::Claude,
            conversation_id: "--continue".into(),
        };
        assert!(conversation_resume_arguments(Program::Claude, &latest).is_err());
    }
}
