//! Explicit owner-declared display forwarding. Callback data is not quota permission.
use crate::{
    api_error::Error,
    jobs::LaunchSpec,
    launchers::{Program, Version},
};
use anyhow::{Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const PROFILE_LIMIT: usize = 16 * 1024;
const INPUT_LIMIT: usize = 256 * 1024;
const OUTPUT_LIMIT: usize = 64 * 1024;
const FRAME_LIMIT: usize = 512 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub display_profile: String,
}
pub(crate) fn deserialize_options<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<Options>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Options::deserialize(deserializer).map(Some)
}
impl Options {
    pub fn validate(&self, program: Program) -> Result<()> {
        if program != Program::Claude
            || self.display_profile.is_empty()
            || self.display_profile.len() > 4096
            || self.display_profile.chars().any(char::is_control)
            || !Path::new(&self.display_profile).is_absolute()
        {
            return Err(Error::new("invalid_argument", "Claude quota capture requires an absolute owner display-profile path and Claude program").into());
        }
        Ok(())
    }
}
pub fn validate(options: &Options, program: Program, versions: &[Version]) -> Result<()> {
    options.validate(program)?;
    if !versions.iter().any(|version| {
        version.program == Program::Claude
            && version.status == "ready"
            && version
                .version
                .as_deref()
                .is_some_and(crate::caller::supports_claude_harness)
    }) {
        return Err(Error::new(
            "unsupported",
            "Claude quota capture requires a verified supported Claude version",
        )
        .into());
    }
    Ok(())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Display {
    program: PathBuf,
    args: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Profile {
    display: Display,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    padding: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh_interval: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hide_vim_mode_indicator: Option<bool>,
}
impl Profile {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.display.program.is_absolute()
                && self
                    .display
                    .program
                    .to_str()
                    .is_some_and(|s| s.len() <= 4096 && !s.chars().any(char::is_control)),
            "Invalid declared display executable"
        );
        ensure!(
            self.display.args.len() <= 32
                && self
                    .display
                    .args
                    .iter()
                    .all(|arg| arg.len() <= 4096 && !arg.contains('\0'))
                && self.display.args.iter().map(String::len).sum::<usize>() <= 8192,
            "Invalid declared display arguments"
        );
        ensure!(
            self.padding.is_none_or(|value| value <= 32)
                && self
                    .refresh_interval
                    .is_none_or(|value| (1..=3600).contains(&value)),
            "Invalid declared display presentation"
        );
        #[cfg(windows)]
        ensure!(
            !self
                .display
                .program
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(
                    |value| value.eq_ignore_ascii_case("cmd") || value.eq_ignore_ascii_case("bat")
                ),
            "Display needs an explicit executable, not an implicit shell shim"
        );
        Ok(())
    }
}
#[derive(Clone)]
pub struct Prepared {
    profile: Profile,
    fingerprint: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    report: PathBuf,
    profile: Profile,
}

fn file_bytes(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let metadata = std::fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "Display profile must be a regular file"
    );
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.len() <= limit as u64,
        "Display profile is not a bounded regular file"
    );
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        ensure!(
            metadata.file_attributes()
                & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                == 0,
            "Display profile cannot be a reparse point"
        );
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= limit, "Display profile exceeds its bound");
    Ok(bytes)
}
fn prepared(profile: Profile) -> Result<Prepared> {
    profile.validate()?;
    let fingerprint = hex::encode(
        ring::digest::digest(&ring::digest::SHA256, &serde_json::to_vec(&profile)?).as_ref(),
    );
    Ok(Prepared {
        profile,
        fingerprint,
    })
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProfileRequest {
    path: PathBuf,
}

struct ProfileReader {
    child: Option<tokio::process::Child>,
    scope: Option<crate::command_scope::Scope>,
    slot: Option<tokio::sync::OwnedSemaphorePermit>,
    may_terminate: bool,
}
impl ProfileReader {
    fn terminate(&mut self) -> bool {
        if !self.may_terminate {
            return false;
        }
        self.may_terminate = false;
        if let Some(scope) = &self.scope {
            scope.terminate().is_ok()
        } else {
            self.child
                .as_mut()
                .is_some_and(|child| child.start_kill().is_ok())
        }
    }
    async fn cleanup(&mut self) -> bool {
        let killed = self.terminate();
        let confirmed = tokio::time::timeout(Duration::from_secs(2), async {
            self.child
                .as_mut()
                .ok_or_else(|| anyhow::anyhow!("Profile reader unavailable"))?
                .wait()
                .await?;
            while let Some(scope) = &self.scope {
                if scope.empty()? {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await;
        if killed && matches!(confirmed, Ok(Ok(()))) {
            self.child.take();
            self.scope.take();
            self.slot.take();
            true
        } else {
            false
        }
    }
}
impl Drop for ProfileReader {
    fn drop(&mut self) {
        if self.child.is_none() {
            return;
        }
        // Signals precede the first wait, never a recycled/reaped group identity.
        if self.may_terminate {
            let _ = self.terminate();
        }
        let Some(mut child) = self.child.take() else {
            return;
        };
        let scope = self.scope.take();
        let slot = self.slot.take();
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            // No live runtime can admit another reader. Retain rather than
            // release capacity without observing the exact child's cleanup.
            std::mem::forget((child, scope, slot));
            return;
        };
        runtime.spawn(async move {
            loop {
                if child.wait().await.is_ok() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            if let Some(scope) = scope {
                while !matches!(scope.empty(), Ok(true)) {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }
            drop(slot);
        });
    }
}
async fn read_profile(
    mut command: tokio::process::Command,
    path: &Path,
    slot: tokio::sync::OwnedSemaphorePermit,
) -> Result<Prepared> {
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    crate::command_scope::configure(&mut command);
    let child = command.spawn()?;
    let mut owned = ProfileReader {
        child: Some(child),
        scope: None,
        slot: Some(slot),
        may_terminate: true,
    };
    let scope = crate::command_scope::Scope::enroll(
        owned
            .child
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Missing profile reader"))?,
    )?;
    owned.scope = Some(scope);
    let result = tokio::time::timeout(Duration::from_secs(2), async {
        let child = owned
            .child
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Missing profile reader"))?;
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Missing profile input"))?;
        write_frame(
            stdin,
            &ProfileRequest {
                path: path.to_owned(),
            },
        )
        .await?;
        let stdout = child
            .stdout
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Missing profile output"))?;
        let mut length = [0; 4];
        stdout.read_exact(&mut length).await?;
        let length = usize::try_from(u32::from_be_bytes(length))?;
        ensure!(
            length <= PROFILE_LIMIT,
            "Profile response exceeds its bound"
        );
        let mut bytes = vec![0; length];
        stdout.read_exact(&mut bytes).await?;
        prepared(serde_json::from_slice(&bytes)?)
    })
    .await;
    ensure!(owned.cleanup().await, "Profile reader cleanup unconfirmed");
    result.map_err(|_| anyhow::anyhow!("Profile reader timed out"))?
}
/// Called only after immutable receipt replay, before Git or native spawn.
pub async fn prepare(spec: &mut LaunchSpec) -> Result<()> {
    let Some(options) = &spec.claude_quota_capture else {
        return Ok(());
    };
    options.validate(spec.program)?;
    if spec.claude_quota_prepared.is_some() {
        return Ok(());
    }
    static READERS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = READERS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::new("busy", "Display-profile reader capacity is exhausted"))?;
    let mut command = tokio::process::Command::new(std::env::current_exe().map_err(|_| {
        Error::new(
            "invalid_argument",
            "Declared display profile reader is unavailable",
        )
    })?);
    command.arg("--claude-statusline-profile");
    let prepared = read_profile(command, Path::new(&options.display_profile), permit)
        .await
        .map_err(|_| {
            Error::new(
                "invalid_argument",
                "Declared display profile is unavailable or invalid",
            )
        })?;
    spec.claude_quota_prepared = Some(prepared);
    Ok(())
}
/// Private pipe-only adapter. It cannot execute the declared display command.
pub fn profile_child() -> i32 {
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(3));
        std::process::exit(1);
    });
    let result = (|| -> Result<()> {
        let mut input = std::io::stdin();
        let mut length = [0; 4];
        input.read_exact(&mut length)?;
        let length = usize::try_from(u32::from_be_bytes(length))?;
        ensure!(length <= PROFILE_LIMIT, "Profile request exceeds its bound");
        let mut bytes = vec![0; length];
        input.read_exact(&mut bytes)?;
        let request: ProfileRequest = serde_json::from_slice(&bytes)?;
        Options {
            display_profile: request
                .path
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid profile path"))?
                .into(),
        }
        .validate(Program::Claude)?;
        let profile = prepared(serde_json::from_slice(&file_bytes(
            &request.path,
            PROFILE_LIMIT,
        )?)?)?
        .profile;
        let bytes = serde_json::to_vec(&profile)?;
        ensure!(
            bytes.len() <= PROFILE_LIMIT,
            "Profile response exceeds its bound"
        );
        let mut output = std::io::stdout();
        output.write_all(&u32::try_from(bytes.len())?.to_be_bytes())?;
        output.write_all(&bytes)?;
        output.flush()?;
        // Keep the leader identity reserved until contained parent cleanup.
        let mut one = [0];
        let _ = input.read(&mut one);
        Ok(())
    })();
    i32::from(result.is_err())
}
impl Prepared {
    pub fn diagnostic(&self) -> Value {
        json!({"configured":true,"mode":"declaredDisplay","profileFingerprint":self.fingerprint,"observed":null,"globalConfigChanged":false,"inputLimitBytes":INPUT_LIMIT,"outputLimitBytes":OUTPUT_LIMIT,"helperLifetimeMs":if cfg!(unix) {3000} else {4000}})
    }
    pub fn install(&self, report: &Path) -> Result<Value> {
        let manifest = report.with_file_name("claude-statusline.json");
        crate::private_write(
            &manifest,
            &serde_json::to_vec(&Manifest {
                report: report.to_owned(),
                profile: self.profile.clone(),
            })?,
        )?;
        let executable = crate::process::display_path(&std::env::current_exe()?);
        let path = crate::process::display_path(&manifest);
        #[cfg(windows)]
        let command = inherited_command(&executable, &["--claude-statusline", &path]);
        #[cfg(not(windows))]
        let command = format!(
            "'{}' --claude-statusline '{}'",
            executable.replace('\'', "'\\''"),
            path.replace('\'', "'\\''")
        );
        let mut value = json!({"type":"command","command":command});
        if let Some(padding) = self.profile.padding {
            value["padding"] = json!(padding);
        }
        if let Some(interval) = self.profile.refresh_interval {
            value["refreshInterval"] = json!(interval);
        }
        if let Some(hide) = self.profile.hide_vim_mode_indicator {
            value["hideVimModeIndicator"] = json!(hide);
        }
        Ok(value)
    }
}

#[cfg(windows)]
fn inherited_command(executable: &str, args: &[&str]) -> String {
    fn argument(value: &str) -> String {
        let mut result = String::from("\"");
        let mut slashes = 0;
        for character in value.chars() {
            if character == '\\' {
                slashes += 1;
                continue;
            }
            if character == '"' {
                result.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
            } else {
                result.extend(std::iter::repeat_n('\\', slashes));
            }
            slashes = 0;
            result.push(character);
        }
        result.extend(std::iter::repeat_n('\\', slashes * 2));
        result.push('"');
        result
    }
    let arguments = args
        .iter()
        .map(|arg| argument(arg))
        .collect::<Vec<_>>()
        .join(" ");
    // Framework Process.Start sets STARTF_USESTDHANDLES only when a redirect
    // is requested. Redirect/drain stderr to force explicit inherited stdin
    // and stdout without reading input or marshaling output through PowerShell.
    let script = format!(
        "$s=New-Object System.Diagnostics.ProcessStartInfo; $s.FileName='{}'; $s.Arguments='{}'; $s.UseShellExecute=$false; $s.CreateNoWindow=$true; $s.RedirectStandardError=$true; $p=[System.Diagnostics.Process]::Start($s); $d=$p.StandardError.BaseStream.CopyToAsync([System.IO.Stream]::Null); $p.WaitForExit(); [void]$d.GetAwaiter().GetResult(); $r=$p.ExitCode; $p.Dispose(); exit $r",
        executable.replace('\'', "''"),
        arguments.replace('\'', "''")
    );
    let bytes: Vec<_> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!(
        "powershell.exe -NoProfile -NonInteractive -EncodedCommand {}",
        STANDARD.encode(bytes)
    )
}

struct Tee<'a, R> {
    input: &'a mut R,
    copy: &'a mut Vec<u8>,
}
impl<R: Read> Read for Tee<'_, R> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        let count = self.input.read(bytes)?;
        self.copy.extend_from_slice(&bytes[..count]);
        Ok(count)
    }
}
fn collect(report: &Path, mut input: impl Read) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    // receive captures its root/generation ticket before Tee's first read.
    // Failure/rejected scope does not prevent the declared display from running.
    let _ = crate::claude_quota::receive(
        report,
        Tee {
            input: &mut input,
            copy: &mut bytes,
        },
    );
    let remaining = INPUT_LIMIT.saturating_add(1).saturating_sub(bytes.len());
    input.take(remaining as u64).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= INPUT_LIMIT,
        "Declared display input exceeds its bound"
    );
    Ok(bytes)
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Request {
    display: Display,
    input: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Output {
    code: i32,
    output: String,
}
async fn write_frame(output: &mut (impl AsyncWrite + Unpin), value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    ensure!(
        bytes.len() <= FRAME_LIMIT,
        "Display frame exceeds its bound"
    );
    output
        .write_all(&u32::try_from(bytes.len())?.to_be_bytes())
        .await?;
    output.write_all(&bytes).await?;
    output.flush().await?;
    Ok(())
}
async fn read_frame<T: serde::de::DeserializeOwned>(
    input: &mut (impl AsyncRead + Unpin),
) -> Result<T> {
    let mut length = [0; 4];
    input.read_exact(&mut length).await?;
    let length = usize::try_from(u32::from_be_bytes(length))?;
    ensure!(length <= FRAME_LIMIT, "Display frame exceeds its bound");
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes).await?;
    Ok(serde_json::from_slice(&bytes)?)
}
async fn display(display: Display, input: Vec<u8>) -> Result<Output> {
    let mut command = tokio::process::Command::new(display.program);
    command
        .args(display.args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("Display stdin unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("Display stdout unavailable"))?;
    let write = async {
        stdin.write_all(&input).await?;
        // Windows Tokio ChildStdin queues blocking writes. Await flush before
        // closing the final writer so the recipient can observe actual EOF.
        stdin.flush().await?;
        drop(stdin);
        Ok::<_, anyhow::Error>(())
    };
    let read = async {
        let mut bytes = Vec::new();
        stdout
            .take(OUTPUT_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .await?;
        ensure!(
            bytes.len() <= OUTPUT_LIMIT,
            "Declared display output exceeds its bound"
        );
        Ok::<_, anyhow::Error>(bytes)
    };
    let (_, bytes, status) = tokio::try_join!(write, read, async {
        Ok::<_, anyhow::Error>(child.wait().await?)
    })?;
    Ok(Output {
        code: status.code().unwrap_or(1),
        output: STANDARD.encode(bytes),
    })
}
async fn dispatch(display: Display, input: Vec<u8>) -> Result<Output> {
    let mut command = tokio::process::Command::new(std::env::current_exe()?);
    command
        .arg("--claude-statusline-child")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    crate::command_scope::configure(&mut command);
    let mut child = command.spawn()?;
    let scope = match crate::command_scope::Scope::enroll(&child) {
        Ok(scope) => scope,
        Err(_) => {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            anyhow::bail!("Display containment unavailable");
        }
    };
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("Display gate unavailable"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("Display gate unavailable"))?;
    // The enrolled gate cannot execute the declared command before this frame.
    let result = tokio::time::timeout(Duration::from_secs(4), async {
        write_frame(
            &mut stdin,
            &Request {
                display,
                input: STANDARD.encode(input),
            },
        )
        .await?;
        read_frame::<Output>(&mut stdout).await
    })
    .await;
    // The gate deliberately stays alive after its reply, keeping its identity
    // reserved until the entire owned process group/job is terminated here.
    let terminated = scope.terminate().is_ok();
    let reaped = matches!(
        tokio::time::timeout(Duration::from_secs(2), child.wait()).await,
        Ok(Ok(_))
    );
    drop(stdin);
    let empty = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if scope.empty()? {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    ensure!(
        terminated && reaped && matches!(empty, Ok(Ok(()))),
        "Display cleanup unconfirmed"
    );
    result.map_err(|_| anyhow::anyhow!("Declared display timed out"))?
}
pub fn run(manifest: &Path) -> i32 {
    // This is a standalone helper. Bound even an unresponsive filesystem or
    // blocking stdin thread without detaching it into the host process.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(10));
        std::process::exit(1);
    });
    let result = (|| -> Result<Output> {
        let manifest: Manifest = serde_json::from_slice(&file_bytes(manifest, 32 * 1024)?)?;
        manifest.profile.validate()?;
        ensure!(
            manifest.report.is_absolute(),
            "Invalid private quota report"
        );
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let _ = sender.send(collect(&manifest.report, std::io::stdin()));
        });
        let input = receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| anyhow::anyhow!("Declared display input timed out"))??;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(dispatch(manifest.profile.display, input))
    })();
    match result {
        Ok(result) => match STANDARD.decode(result.output) {
            Ok(bytes)
                if bytes.len() <= OUTPUT_LIMIT && std::io::stdout().write_all(&bytes).is_ok() =>
            {
                result.code
            }
            _ => 1,
        },
        Err(_) => {
            eprintln!(
                "nesvo declared status-line forwarding is unavailable; inspect the launch profile"
            );
            1
        }
    }
}
pub fn child() -> i32 {
    #[cfg(unix)]
    {
        let group = unsafe { libc::getpgrp() };
        if group <= 1 || group != i32::try_from(std::process::id()).unwrap_or(0) {
            return 1;
        }
        // Independent bounded cleanup if Claude cancels/kills the outer wrapper.
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            unsafe {
                libc::kill(-group, libc::SIGKILL);
            }
        });
    }
    let result = (|| -> Result<()> {
        let mut stdin = std::io::stdin();
        let mut length = [0; 4];
        stdin.read_exact(&mut length)?;
        let length = usize::try_from(u32::from_be_bytes(length))?;
        ensure!(length <= FRAME_LIMIT, "Display frame exceeds its bound");
        let mut bytes = vec![0; length];
        stdin.read_exact(&mut bytes)?;
        let request: Request = serde_json::from_slice(&bytes)?;
        let profile = Profile {
            display: request.display,
            padding: None,
            refresh_interval: None,
            hide_vim_mode_indicator: None,
        };
        profile.validate()?;
        let input = STANDARD.decode(request.input)?;
        ensure!(
            input.len() <= INPUT_LIMIT,
            "Declared display input exceeds its bound"
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let result = runtime.block_on(display(profile.display, input))?;
        let bytes = serde_json::to_vec(&result)?;
        ensure!(
            bytes.len() <= FRAME_LIMIT,
            "Display frame exceeds its bound"
        );
        let mut stdout = std::io::stdout();
        stdout.write_all(&u32::try_from(bytes.len())?.to_be_bytes())?;
        stdout.write_all(&bytes)?;
        stdout.flush()?;
        // Keep the group leader alive until the parent has killed/reaped it.
        let mut one = [0];
        let _ = stdin.read(&mut one);
        #[cfg(unix)]
        unsafe {
            libc::kill(-libc::getpgrp(), libc::SIGKILL);
        }
        Ok(())
    })();
    i32::from(result.is_err())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn executable() -> PathBuf {
        #[cfg(windows)]
        {
            PathBuf::from(crate::command_scope::system_root().unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe")
        }
        #[cfg(not(windows))]
        {
            PathBuf::from("/bin/sh")
        }
    }
    #[test]
    fn strict_manifest_requires_declared_absolute_executable_and_bounds() {
        let program = if cfg!(windows) {
            "C:/Windows/System32/cmd.exe"
        } else {
            "/bin/sh"
        };
        let value = json!({"display":{"program":program,"args":[]},"padding":2});
        let profile: Profile = serde_json::from_value(value.clone()).unwrap();
        profile.validate().unwrap();
        for invalid in [
            json!({"display":{"program":"relative","args":[]}}),
            json!({"display":{"program":program,"args":[]},"refreshInterval":0}),
            json!({"display":{"program":program,"args":[]},"unknown":true}),
        ] {
            assert!(
                serde_json::from_value::<Profile>(invalid)
                    .and_then(|profile| profile
                        .validate()
                        .map_err(<serde_json::Error as serde::de::Error>::custom))
                    .is_err()
            );
        }
        let options = Options {
            display_profile: program.into(),
        };
        assert!(options.validate(Program::Claude).is_ok());
        assert!(options.validate(Program::Codex).is_err());
    }
    #[test]
    fn owner_only_profile_and_internal_preparation_cannot_be_supplied_by_input() {
        let capture = json!({"displayProfile":executable()});
        let profile: crate::workflow_launches::Profile = serde_json::from_value(
            json!({"program":"claude","workspace":"shared","claudeQuotaCapture":capture}),
        )
        .unwrap();
        assert!(profile.validate_capture(true).is_ok());
        assert!(profile.validate_capture(false).is_err());
        let spec: LaunchSpec = serde_json::from_value(json!({"name":"Declared display","program":"claude","claudeQuotaCapture":capture,"claudeQuotaOwnerSelected":true,"claudeQuotaPrepared":{"anything":true}})).unwrap();
        assert!(!spec.claude_quota_owner_selected);
        assert!(spec.claude_quota_prepared.is_none());
        let serialized = serde_json::to_value(spec).unwrap();
        assert!(serialized.get("claudeQuotaOwnerSelected").is_none());
        assert!(serialized.get("claudeQuotaPrepared").is_none());
    }
    #[test]
    fn capture_dtos_reject_present_null_and_preserve_omission_and_objects() {
        for capture in [
            None,
            Some(Value::Null),
            Some(json!({"displayProfile":"/owner/display.json"})),
        ] {
            let mut launch = json!({"name":"Declared display","program":"claude"});
            let mut profile = json!({"program":"claude","workspace":"shared"});
            if let Some(value) = &capture {
                launch["claudeQuotaCapture"] = value.clone();
                profile["claudeQuotaCapture"] = value.clone();
            }
            let launch = serde_json::from_value::<LaunchSpec>(launch);
            let parsed =
                serde_json::from_value::<crate::workflow_launches::Profile>(profile.clone());
            let invalid = capture.as_ref().is_some_and(Value::is_null);
            assert_eq!(launch.is_err(), invalid);
            assert_eq!(parsed.is_err(), invalid);
            if !invalid {
                assert_eq!(
                    serde_json::to_value(launch.unwrap())
                        .unwrap()
                        .get("claudeQuotaCapture"),
                    capture.as_ref()
                );
                assert_eq!(
                    serde_json::to_value(parsed.unwrap())
                        .unwrap()
                        .get("claudeQuotaCapture"),
                    capture.as_ref()
                );
            }
            let request = json!({"key":"launch","runId":"r","taskId":"t","expectedRevision":1,"profile":profile});
            assert_eq!(
                serde_json::from_value::<crate::workflow_launches::Request>(request).is_err(),
                invalid
            );
            let executor = json!({"action":"start","key":"executor","runId":"r","expectedRevision":1,"spec":{"tasks":[{"taskId":"t","profile":profile}]}});
            assert_eq!(
                serde_json::from_value::<crate::workflow_executor::Request>(executor).is_err(),
                invalid
            );
            for action in ["create", "update"] {
                let mut job = json!({"action":action,"key":"job","spec":{"title":"Declared display","instruction":"Report result","profile":profile,"schedule":{"kind":"external"}}});
                if action == "update" {
                    job["jobId"] = json!("j");
                    job["expectedRevision"] = json!(1);
                }
                assert_eq!(
                    serde_json::from_value::<crate::job_definitions::Request>(job).is_err(),
                    invalid
                );
            }
        }
    }
    #[tokio::test]
    async fn manifest_is_bound_once_and_settings_default_does_not_override_statusline() {
        let root = std::env::temp_dir().join(format!(
            "nesvo-display-profile-{}",
            hex::encode(crate::wire::random::<8>())
        ));
        std::fs::create_dir(&root).unwrap();
        let manifest = root.join("declared.json");
        std::fs::write(&manifest,serde_json::to_vec(&json!({"display":{"program":executable(),"args":["private manifest argument"]},"padding":2,"refreshInterval":9,"hideVimModeIndicator":true})).unwrap()).unwrap();
        // Unit tests cannot re-exec the production main from a Rust test binary.
        // Native acceptance covers that reader; bind its validated response here.
        let bound =
            prepared(serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap()).unwrap();
        let mut spec = LaunchSpec {
            name: "Declared display".into(),
            program: Program::Claude,
            claude_quota_capture: Some(Options {
                display_profile: manifest.to_str().unwrap().into(),
            }),
            claude_quota_prepared: Some(bound),
            ..Default::default()
        };
        std::fs::write(&manifest, b"invalid changed file").unwrap();
        prepare(&mut spec).await.unwrap();
        let prepared = spec.claude_quota_prepared.as_ref().unwrap();
        let mut command = portable_pty::CommandBuilder::new("fixture");
        let tracker = crate::agent_context::Tracker::install_claude(
            &mut command,
            "display-session",
            None,
            Some(prepared),
        )
        .unwrap();
        let argv = command.get_argv();
        assert_eq!(argv.iter().filter(|arg| *arg == "--settings").count(), 1);
        let index = argv.iter().position(|arg| arg == "--settings").unwrap();
        let settings: Value = serde_json::from_str(argv[index + 1].to_str().unwrap()).unwrap();
        assert_eq!(settings["statusLine"]["padding"], 2);
        assert_eq!(settings["statusLine"]["refreshInterval"], 9);
        assert_eq!(settings["statusLine"]["hideVimModeIndicator"], true);
        assert!(settings["hooks"]["UserPromptSubmit"].is_array());
        let retained: Manifest = serde_json::from_slice(
            &std::fs::read(tracker.report().with_file_name("claude-statusline.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            retained.profile.display.args,
            vec!["private manifest argument"]
        );
        let public = tracker.capture_diagnostic().unwrap().to_string();
        assert!(!public.contains("private manifest argument"));
        assert!(tracker.capture_diagnostic().unwrap()["observed"].is_null());
        let mut default = portable_pty::CommandBuilder::new("fixture");
        let default_tracker = crate::agent_context::Tracker::install_claude(
            &mut default,
            "default-session",
            None,
            None,
        )
        .unwrap();
        assert!(default_tracker.capture_diagnostic().is_none());
        let argv = default.get_argv();
        let index = argv.iter().position(|arg| arg == "--settings").unwrap();
        let settings: Value = serde_json::from_str(argv[index + 1].to_str().unwrap()).unwrap();
        assert!(settings.get("statusLine").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
    fn blocked_reader_command() -> tokio::process::Command {
        #[cfg(windows)]
        {
            let mut command = tokio::process::Command::new(executable());
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ]);
            command
        }
        #[cfg(not(windows))]
        {
            let mut command = tokio::process::Command::new("/bin/sleep");
            command.arg("30");
            command
        }
    }
    #[tokio::test]
    async fn blocked_profile_reader_is_killed_and_reaped_before_its_slot_releases() {
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let slot = slots.clone().acquire_owned().await.unwrap();
        let started = tokio::time::Instant::now();
        let result = read_profile(blocked_reader_command(), &executable(), slot).await;
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(
            slots.available_permits(),
            1,
            "Confirmed reap releases the exact reader's capacity"
        );
    }
    #[tokio::test]
    async fn canceled_profile_reader_retains_capacity_until_cleanup_observation() {
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let slot = slots.clone().acquire_owned().await.unwrap();
        let task = tokio::spawn(async move {
            read_profile(blocked_reader_command(), &executable(), slot).await
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(slots.available_permits(), 0);
        task.abort();
        let _ = task.await;
        tokio::time::timeout(Duration::from_secs(3), async {
            while slots.available_permits() == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(slots.available_permits(), 1);
    }
    #[tokio::test]
    async fn invalid_profile_frame_is_refused_with_confirmed_cleanup() {
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let slot = slots.clone().acquire_owned().await.unwrap();
        #[cfg(windows)]
        let command = {
            let mut command = tokio::process::Command::new(executable());
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::Out.Write('bad!'); [Console]::Out.Flush(); Start-Sleep -Seconds 30",
            ]);
            command
        };
        #[cfg(not(windows))]
        let command = {
            let mut command = tokio::process::Command::new("/bin/sh");
            command.args(["-c", "printf 'bad!'; sleep 30"]);
            command
        };
        assert!(read_profile(command, &executable(), slot).await.is_err());
        assert_eq!(slots.available_permits(), 1);
    }
    #[tokio::test]
    async fn capture_failure_does_not_change_input_stdout_or_display_exit() {
        let report = std::env::temp_dir()
            .join(format!(
                "nesvo-no-quota-scope-{}",
                hex::encode(crate::wire::random::<8>())
            ))
            .join("missing.json");
        let original = b"{\"session_id\":\"unbound\",\"private\":\"literal input\"}";
        let input = collect(&report, std::io::Cursor::new(original)).unwrap();
        assert_eq!(input, original);
        #[cfg(unix)]
        let declared = Display {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "cat; exit 7".into()],
        };
        #[cfg(windows)]
        let declared = Display {
            program: PathBuf::from(crate::command_scope::system_root().unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
            args: vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "[Console]::Out.Write([Console]::In.ReadToEnd()); exit 7".into(),
            ],
        };
        let output = tokio::time::timeout(Duration::from_secs(3), display(declared, input))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(output.code, 7);
        assert_eq!(STANDARD.decode(output.output).unwrap(), original);
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn generated_windows_command_inherits_raw_standard_handles() {
        let executable = PathBuf::from(crate::command_scope::system_root().unwrap())
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        let prefix = "\u{1b}[35mZażółć 日本語\u{1b}[0m\r\n".as_bytes();
        let original = b"{\"literal\":\"stdin\\nbytes\"}\n";
        let script = format!(
            "$m=New-Object System.IO.MemoryStream; [Console]::OpenStandardInput().CopyTo($m); $o=[Console]::OpenStandardOutput(); $b=[Convert]::FromBase64String('{}'); $o.Write($b,0,$b.Length); $b=$m.ToArray(); $o.Write($b,0,$b.Length); $o.Flush(); exit 7",
            STANDARD.encode(prefix)
        );
        let encoded = STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        let command_text = inherited_command(
            executable.to_str().unwrap(),
            &["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded],
        );
        let shell = PathBuf::from(crate::command_scope::system_root().unwrap())
            .join("System32")
            .join("cmd.exe");
        let release = std::env::temp_dir().join(format!(
            "nesvo-capture-shell-{}.release",
            hex::encode(crate::wire::random::<16>())
        ));
        // This bootstrap cannot start CMD/the generated command until the exact
        // owned process has been enrolled. It never reads provider input.
        let bootstrap = format!(
            "$timer=[Diagnostics.Stopwatch]::StartNew(); while(-not [System.IO.File]::Exists('{}')){{if($timer.ElapsedMilliseconds -ge 5000){{exit 1}}; [Threading.Thread]::Sleep(10)}}; $s=New-Object System.Diagnostics.ProcessStartInfo; $s.FileName='{}'; $s.Arguments='/d /s /c {}'; $s.UseShellExecute=$false; $s.CreateNoWindow=$true; $s.RedirectStandardError=$true; $p=[System.Diagnostics.Process]::Start($s); $d=$p.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError()); $p.WaitForExit(); [void]$d.GetAwaiter().GetResult(); exit $p.ExitCode",
            release.to_str().unwrap().replace('\'', "''"),
            shell.to_str().unwrap().replace('\'', "''"),
            command_text.replace('\'', "''")
        );
        let encoded = STANDARD.encode(
            bootstrap
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        let mut command = tokio::process::Command::new(executable);
        command
            .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        command.creation_flags(0x08000000);
        let mut child = command.spawn().unwrap();
        let scope = crate::command_scope::Scope::enroll(&child).unwrap();
        std::fs::write(&release, b"owned job enrolled").unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let mut output = Vec::new();
        let mut diagnostic = Vec::new();
        let result = tokio::time::timeout(Duration::from_secs(8), async {
            input.write_all(original).await?;
            input.flush().await?;
            drop(input);
            let (status, _, _) = tokio::try_join!(
                child.wait(),
                stdout.read_to_end(&mut output),
                stderr.read_to_end(&mut diagnostic)
            )?;
            Ok::<_, std::io::Error>(status)
        })
        .await;
        // Killing only CMD leaves its PS grandchildren and blocking pipe reads.
        // Terminate the exact job before any assertion/unwind or final wait.
        let terminated = scope.terminate();
        let reaped = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        let _ = std::fs::remove_file(release);
        assert!(
            terminated.is_ok() && matches!(reaped, Ok(Ok(_))),
            "Owned generated-command fixture cleanup"
        );
        let status = result
            .unwrap_or_else(|_| {
                panic!(
                    "Generated command timeout; owned stderr: {}",
                    String::from_utf8_lossy(&diagnostic)
                )
            })
            .unwrap();
        assert_eq!(
            status.code(),
            Some(7),
            "Owned fixture stderr: {}",
            String::from_utf8_lossy(&diagnostic)
        );
        let mut expected = prefix.to_vec();
        expected.extend_from_slice(original);
        assert_eq!(output, expected);
    }
}
